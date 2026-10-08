/** Consume the local callback in the authenticated DSH page, independently of popup openers. */
import { createRoot } from "react-dom/client";
import { jsonRequest } from "./api.ts";
import { LOGIN_CODE_PATH, STATUS_PATH } from "./constants.ts";
import type { GrokBuildSettingsInjected } from "./GrokBuildSettings.tsx";
import { isMatchingClaudeCallback } from "./parsers.ts";
import { bodyStyle, buttonStyle, panelStyle, titleStyle } from "./styles.ts";
import type { CodingOAuthStatus } from "./types.ts";

const RETURN_KEY = "dsh-claude-callback";

/** Erase even malformed return payloads before fetching, rendering, or loading other resources. */
export function takeClaudeBridgeReturn(location: Location, history: History): string | undefined {
	const params = new URLSearchParams(location.hash.slice(1));
	if (!params.has(RETURN_KEY)) return undefined;
	const values = params.getAll(RETURN_KEY);
	history.replaceState(history.state, "", `${location.pathname}${location.search}`);
	return values.length === 1 && values[0]!.length <= 8192 ? values[0]! : "";
}

interface ReturnDependencies {
	request: typeof jsonRequest;
	wait: (signal: AbortSignal) => Promise<void>;
}

/** Submission queues the native OAuth prompt; only this attempt's persisted receipt confirms completion. */
export async function finishClaudeBridgeReturn(
	callback: string,
	signal: AbortSignal,
	dependencies: ReturnDependencies = {
		request: jsonRequest,
		wait: (signal) =>
			new Promise<void>((resolve, reject) => {
				const aborted = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", aborted);
					reject(new Error("Sign-in stopped."));
				};
				const timer = setTimeout(() => {
					signal.removeEventListener("abort", aborted);
					resolve();
				}, 500);
				signal.addEventListener("abort", aborted, { once: true });
				if (signal.aborted) aborted();
			}),
	},
): Promise<void> {
	if (!callback || callback.length > 8192 || signal.aborted) throw new Error("Invalid callback.");
	const initial = await dependencies.request<CodingOAuthStatus>(STATUS_PATH, "GET", undefined, signal);
	const pending = initial.providers.claude;
	const attemptId = pending.loginAttemptId;
	if (
		pending.status !== "signing-in" ||
		pending.method !== "browser" ||
		typeof attemptId !== "string" ||
		attemptId.length === 0 ||
		!isMatchingClaudeCallback(callback, pending.url)
	) {
		throw new Error("This callback does not match a pending Claude sign-in.");
	}
	if (signal.aborted) throw new Error("Sign-in stopped.");
	await dependencies.request(
		LOGIN_CODE_PATH,
		"POST",
		{ provider: "claude", code: callback, loginAttemptId: attemptId },
		signal,
	);
	for (let attempt = 0; attempt < 60; attempt += 1) {
		if (signal.aborted) throw new Error("Sign-in stopped.");
		const status = (await dependencies.request<CodingOAuthStatus>(STATUS_PATH, "GET", undefined, signal)).providers
			.claude;
		// Native status preserves an existing account after a failed new login.
		// That stored account must not turn this callback's failure into success.
		if (status.operationError) throw new Error("Sign-in did not complete.");
		if (status.status === "signed-in" && status.completedLoginAttemptId === attemptId) return;
		if (
			status.status !== "signing-in" ||
			status.method !== "browser" ||
			status.loginAttemptId !== attemptId ||
			!isMatchingClaudeCallback(callback, status.url)
		) {
			throw new Error("Sign-in did not complete.");
		}
		await dependencies.wait(signal);
	}
	throw new Error("Sign-in timed out.");
}

export function mountClaudeBridgeReturn(callback: string, t: GrokBuildSettingsInjected["t"]): () => void {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const controller = new AbortController();
	let disposed = false;
	let finished = false;
	const dismiss = () => {
		disposed = true;
		controller.abort();
		root.unmount();
		host.remove();
		window.close();
	};
	const render = (state: "pending" | "success" | "failure") =>
		root.render(
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="claude-bridge-return-title"
				style={{
					position: "fixed",
					inset: 0,
					zIndex: 50,
					display: "grid",
					placeItems: "center",
					padding: 20,
					background: "var(--dsw-alias-bg-layer-1, #fff)",
				}}
			>
				<section style={{ ...panelStyle, width: "min(480px, 100%)", boxSizing: "border-box" }}>
					<h2 id="claude-bridge-return-title" style={titleStyle}>
						{t(
							state === "pending"
								? "finishingSignIn"
								: state === "success"
									? "bridgeReturnSuccess"
									: "bridgeReturnFailure",
						)}
					</h2>
					<p role={state === "failure" ? "alert" : "status"} style={bodyStyle}>
						{t(
							state === "pending"
								? "bridgeReturnPendingHint"
								: state === "success"
									? "bridgeReturnSuccessHint"
									: "bridgeReturnFailureHint",
						)}
					</p>
					{state === "pending" ? null : (
						<button type="button" style={buttonStyle} onClick={dismiss}>
							{t("bridgeReturnClose")}
						</button>
					)}
				</section>
			</div>,
		);
	render("pending");
	const timeout = setTimeout(() => {
		controller.abort();
	}, 30_000);
	void finishClaudeBridgeReturn(callback, controller.signal)
		.then(
			() => {
				if (!disposed) render("success");
			},
			() => {
				if (!disposed) render("failure");
			},
		)
		.finally(() => {
			finished = true;
			clearTimeout(timeout);
		});
	return () => {
		disposed = true;
		clearTimeout(timeout);
		if (!finished) controller.abort();
		root.unmount();
		host.remove();
	};
}
