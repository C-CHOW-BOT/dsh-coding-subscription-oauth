import type { AuthInteraction } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { SubscriptionWebAuth } from "../src/auth-routes.ts";
import { OAUTH_PROVIDER_DEFINITIONS } from "../src/oauth-providers.ts";

function fixture() {
	let finish: () => void = () => undefined;
	let fail: (error: Error) => void = () => undefined;
	let authorizeUrl = "https://claude.ai/oauth/authorize?state=fixture";
	let pausedRead: { entered: () => void; wait: Promise<void> } | undefined;
	const session = {
		definition: OAUTH_PROVIDER_DEFINITIONS.find((definition) => definition.slug === "claude")!,
		availableModels: () => [{ id: "model" }],
		selectedModelIds: () => ["model"],
		visibleModels: () => [{ id: "model" }],
		store: {
			listAccounts: async () => [{ id: "existing" }],
			getActiveAccountId: async () => "existing",
			setActiveAccount: async () => undefined,
			removeAccount: async () => undefined,
		},
		setSelectedModels: async () => undefined,
		notifyCredentialChange: () => undefined,
		status: async () => {
			const paused = pausedRead;
			pausedRead = undefined;
			if (paused !== undefined) {
				paused.entered();
				await paused.wait;
			}
			return { authenticated: true };
		},
		login: async (interaction: AuthInteraction) => {
			interaction.notify({ type: "auth_url", url: authorizeUrl });
			await interaction.prompt({ type: "manual_code", message: "Enter callback" });
			await new Promise<void>((resolve, reject) => {
				finish = resolve;
				fail = reject;
				interaction.signal?.addEventListener("abort", () => reject(interaction.signal?.reason), { once: true });
			});
		},
	};
	return {
		auth: new SubscriptionWebAuth(session as never),
		finish: () => finish(),
		fail: () => fail(new Error("Token exchange failed")),
		next: () => {
			authorizeUrl = "https://claude.ai/oauth/authorize?state=another-fixture";
		},
		pauseNextStoredRead: () => {
			let release: () => void = () => undefined;
			let signalEntered: () => void = () => undefined;
			const wait = new Promise<void>((resolve) => {
				release = resolve;
			});
			const entered = new Promise<void>((resolve) => {
				signalEntered = resolve;
			});
			pausedRead = { entered: () => signalEntered(), wait };
			return { entered, release: () => release() };
		},
	};
}

it("issues a completion receipt only after the matching login persists, and resets it for retries", async () => {
	const { auth, finish, next } = fixture();
	try {
		await auth.signIn("browser");
		const first = (await auth.status()).loginAttemptId;
		expect(first).toEqual(expect.any(String));
		await auth.submitCode("fixture-code");
		expect(await auth.status()).toMatchObject({ status: "signing-in", loginAttemptId: first });
		expect(await auth.status()).not.toHaveProperty("completedLoginAttemptId");
		finish();
		await vi.waitFor(async () =>
			expect(await auth.status()).toMatchObject({ status: "signed-in", completedLoginAttemptId: first }),
		);
		next();
		await auth.signIn("browser");
		const pending = await auth.status();
		expect(pending.loginAttemptId).not.toBe(first);
		expect(pending).not.toHaveProperty("completedLoginAttemptId");
		await auth.cancel();
		expect(await auth.status()).toMatchObject({ status: "signed-in", activeAccountId: "existing" });
		expect(await auth.status()).not.toHaveProperty("completedLoginAttemptId");
	} finally {
		await auth.dispose();
	}
});

it("preserving an old account after failed or canceled token exchange never produces a completion receipt", async () => {
	const { auth, fail } = fixture();
	try {
		await auth.signIn("browser");
		await auth.submitCode("fixture-code");
		fail();
		await vi.waitFor(async () => expect((await auth.status()).operationError).toBe("Token exchange failed"));
		expect(await auth.status()).toMatchObject({ status: "signed-in", activeAccountId: "existing" });
		expect(await auth.status()).not.toHaveProperty("completedLoginAttemptId");
		await auth.cancel();
		expect(await auth.status()).not.toHaveProperty("operationError");
		await auth.signIn("browser");
		await auth.submitCode("another-fixture-code");
		await auth.cancel();
		expect(await auth.status()).toMatchObject({ status: "signed-in", activeAccountId: "existing" });
		expect(await auth.status()).not.toHaveProperty("operationError");
		expect(await auth.status()).not.toHaveProperty("completedLoginAttemptId");
	} finally {
		await auth.dispose();
	}
});

it("rejects an earlier attempt's callback before consuming the current attempt's code resolver", async () => {
	const { auth, finish, next } = fixture();
	try {
		await auth.signIn("browser");
		const first = (await auth.status()).loginAttemptId;
		await auth.cancel();
		next();
		await auth.signIn("browser");
		const current = (await auth.status()).loginAttemptId;
		expect(current).not.toBe(first);
		await expect(auth.submitCode("stale-fixture-code", first)).rejects.toThrow(/does not match/);
		expect(await auth.status()).toMatchObject({ status: "signing-in", loginAttemptId: current });
		await auth.submitCode("current-fixture-code", current);
		finish();
		await vi.waitFor(async () =>
			expect(await auth.status()).toMatchObject({ status: "signed-in", completedLoginAttemptId: current }),
		);
	} finally {
		await auth.dispose();
	}
});

it("does not let a canceled attempt's slow stored-status read hide a newer pending login", async () => {
	const { auth, finish, next, pauseNextStoredRead } = fixture();
	const paused = pauseNextStoredRead();
	let canceled: Promise<void> | undefined;
	try {
		await auth.signIn("browser");
		const first = (await auth.status()).loginAttemptId;
		canceled = auth.cancel();
		await paused.entered;
		next();
		const challenge = await auth.signIn("browser");
		const current = (await auth.status()).loginAttemptId;
		expect(current).not.toBe(first);
		paused.release();
		await canceled;
		expect(await auth.status()).toMatchObject({
			status: "signing-in",
			loginAttemptId: current,
			url: challenge.url,
		});
		await auth.submitCode("current-fixture-code", current);
		finish();
		await vi.waitFor(async () =>
			expect(await auth.status()).toMatchObject({ status: "signed-in", completedLoginAttemptId: current }),
		);
	} finally {
		paused.release();
		await canceled;
		await auth.dispose();
	}
});

const mutations = [
	["model selection", (auth: SubscriptionWebAuth) => auth.setModels(["model"])],
	["active account", (auth: SubscriptionWebAuth) => auth.setActiveAccount("existing")],
	["account removal", (auth: SubscriptionWebAuth) => auth.removeAccount("unrelated-account")],
] as const;

it.each(mutations)("preserves the pending challenge through a %s update", async (_label, mutate) => {
	const { auth, finish } = fixture();
	try {
		const challenge = await auth.signIn("browser");
		const attemptId = (await auth.status()).loginAttemptId;
		await mutate(auth);
		expect(await auth.status()).toMatchObject({ status: "signing-in", loginAttemptId: attemptId, url: challenge.url });
		await auth.submitCode("fixture-code", attemptId);
		finish();
		await vi.waitFor(async () =>
			expect(await auth.status()).toMatchObject({ status: "signed-in", completedLoginAttemptId: attemptId }),
		);
	} finally {
		await auth.dispose();
	}
});

it.each(mutations)("does not let a %s update's deferred stored read hide a new login", async (_label, mutate) => {
	const { auth, finish, pauseNextStoredRead } = fixture();
	const paused = pauseNextStoredRead();
	const updated = mutate(auth);
	try {
		await paused.entered;
		const challenge = await auth.signIn("browser");
		const attemptId = (await auth.status()).loginAttemptId;
		paused.release();
		await updated;
		expect(await auth.status()).toMatchObject({ status: "signing-in", loginAttemptId: attemptId, url: challenge.url });
		await auth.submitCode("fixture-code", attemptId);
		finish();
		await vi.waitFor(async () =>
			expect(await auth.status()).toMatchObject({ status: "signed-in", completedLoginAttemptId: attemptId }),
		);
	} finally {
		paused.release();
		await updated;
		await auth.dispose();
	}
});
