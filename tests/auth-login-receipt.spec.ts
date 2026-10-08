import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { Context } from "@deepseek-ai/cordis";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { CODING_OAUTH_LOGIN_PATH, registerCodingOAuthRoutes, SubscriptionWebAuth } from "../src/auth-routes.ts";
import { OAUTH_PROVIDER_DEFINITIONS } from "../src/oauth-providers.ts";
import { OAuthProviderSession } from "../src/oauth-session.ts";
import { OAuthCredentialFileStore } from "../src/store.ts";

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

async function nativeLogoutFixture(slug: "claude" | "codex" = "claude") {
	const directory = await mkdtemp(join(tmpdir(), "dsh-oauth-login-lifecycle-"));
	const base = OAUTH_PROVIDER_DEFINITIONS.find((definition) => definition.slug === slug)!;
	const credential = {
		type: "oauth" as const,
		access: "fixture-access",
		refresh: "fixture-refresh",
		expires: Date.now() + 3_600_000,
	};
	const store = new OAuthCredentialFileStore(base.nativeProviderId, join(directory, "auth.json"), base.route);
	await store.modify(base.nativeProviderId, async () => credential);
	const definition = {
		...base,
		providerFactory: () => {
			const provider = base.providerFactory();
			return {
				...provider,
				auth: {
					...provider.auth,
					oauth: {
						...provider.auth.oauth!,
						login: async (interaction: AuthInteraction) => {
							interaction.notify({ type: "auth_url", url: "https://claude.ai/oauth/authorize?state=fixture" });
							await interaction.prompt({ type: "manual_code", message: "Enter fixture callback" });
							return { ...credential, access: "fixture-new-access", refresh: "fixture-new-refresh" };
						},
					},
				},
			};
		},
	};
	const session = new OAuthProviderSession(definition, undefined, store, join(directory, "models.json"));
	const auth = new SubscriptionWebAuth(session);
	let release: () => void = () => undefined;
	let fail: (error: Error) => void = () => undefined;
	let entered: () => void = () => undefined;
	const deletionEntered = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const deletionWait = new Promise<void>((resolve, reject) => {
		release = resolve;
		fail = reject;
	});
	const deleteCredential = store.delete.bind(store);
	const deletion = vi.spyOn(store, "delete").mockImplementation(async (providerId) => {
		entered();
		await deletionWait;
		await deleteCredential(providerId);
	});
	return {
		auth,
		session,
		deletion,
		deletionEntered,
		release: () => release(),
		fail: () => fail(new Error("Fixture credential deletion failed")),
		close: async () => {
			release();
			await auth.dispose();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

function registeredLoginFixture(session: OAuthProviderSession) {
	type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
	const routes = new Map<string, RouteHandler>();
	const cleanups: Array<() => void | Promise<void>> = [];
	const context = {
		webServer: {
			register: (route: { path: string; handler: RouteHandler }) => {
				routes.set(route.path, route.handler);
				return () => routes.delete(route.path);
			},
		},
		effect: (setup: () => void | (() => void | Promise<void>)) => {
			const cleanup = setup();
			if (typeof cleanup === "function") cleanups.push(cleanup);
		},
	} as unknown as Context;
	registerCodingOAuthRoutes(context, {} as never, [session]);
	let disposed = false;
	return {
		handler: routes.get(CODING_OAUTH_LOGIN_PATH)!,
		routes,
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			for (const cleanup of cleanups.reverse()) await cleanup();
		},
	};
}

it("rejects a new browser login until a coalesced native logout finishes, then preserves its persisted receipt", async () => {
	const f = await nativeLogoutFixture();
	const signingOut = f.auth.signOut();
	let repeated: Promise<void> | undefined;
	try {
		await f.deletionEntered;
		repeated = f.auth.signOut();
		expect(f.deletion).toHaveBeenCalledOnce();
		await expect(f.auth.signIn("browser")).rejects.toThrow("sign-out is still completing; retry when it finishes");
		expect(await f.auth.status()).toMatchObject({ status: "signed-in" });
		expect(await f.auth.status()).not.toHaveProperty("loginAttemptId");
		expect(await f.auth.status()).not.toHaveProperty("completedLoginAttemptId");
		f.release();
		await Promise.all([signingOut, repeated]);
		expect(await f.session.status()).toEqual({ authenticated: false });
		const challenge = await f.auth.signIn("browser");
		const pending = await f.auth.status();
		expect(pending).toMatchObject({ status: "signing-in", url: challenge.url });
		expect(pending.loginAttemptId).toEqual(expect.any(String));
		await f.auth.submitCode("fixture-code", pending.loginAttemptId);
		await vi.waitFor(async () =>
			expect(await f.auth.status()).toMatchObject({
				status: "signed-in",
				completedLoginAttemptId: pending.loginAttemptId,
			}),
		);
		expect(await f.session.storedCredential()).toMatchObject({ access: "fixture-new-access" });
		expect(f.deletion).toHaveBeenCalledOnce();
	} finally {
		f.release();
		await Promise.all([signingOut, repeated]);
		await f.close();
	}
});

it("returns a retryable HTTP conflict when native logout is still completing", async () => {
	const f = await nativeLogoutFixture();
	const signingOut = f.auth.signOut();
	const signIn = f.auth.signIn.bind(f.auth);
	const dispatch = vi.spyOn(SubscriptionWebAuth.prototype, "signIn").mockImplementation(signIn);
	const route = registeredLoginFixture(f.session);
	try {
		await f.deletionEntered;
		const request = Readable.from([JSON.stringify({ provider: "claude", method: "browser" })]);
		Object.assign(request, {
			method: "POST",
			headers: { host: "127.0.0.1:3080" },
			socket: { remoteAddress: "127.0.0.1" },
		});
		let status = 0;
		let body = "";
		await route.handler(
			request as unknown as IncomingMessage,
			{
				writeHead: (value: number) => {
					status = value;
				},
				end: (value: string) => {
					body = value;
				},
			} as unknown as ServerResponse,
		);
		expect(status).toBe(409);
		expect(JSON.parse(body)).toEqual({
			error: "claude-code-oauth: sign-out is still completing; retry when it finishes",
		});
	} finally {
		dispatch.mockRestore();
		f.release();
		await signingOut;
		await route.dispose();
		await f.close();
	}
});

it("rejects an accepted partial-body login request after its native route owner is disposed", async () => {
	const f = await nativeLogoutFixture();
	const route = registeredLoginFixture(f.session);
	const login = vi.spyOn(f.session, "login");
	const request = new PassThrough();
	Object.assign(request, {
		method: "POST",
		headers: { host: "127.0.0.1:3080" },
		socket: { remoteAddress: "127.0.0.1" },
	});
	let status = 0;
	let body = "";
	const pending = route.handler(
		request as unknown as IncomingMessage,
		{
			writeHead: (value: number) => {
				status = value;
			},
			end: (value: string) => {
				body = value;
			},
		} as unknown as ServerResponse,
	);
	try {
		const reading = new Promise<void>((resolve) => request.once("data", () => resolve()));
		request.write('{"provider":"claude",');
		await reading;
		await route.dispose();
		expect(route.routes.size).toBe(0);
		request.end('"method":"browser"}');
		await pending;
		expect(status).toBe(409);
		expect(JSON.parse(body)).toEqual({ error: "claude-code-oauth: plugin disposed; reload after it is available" });
		expect(login).not.toHaveBeenCalled();
		expect(await f.session.storedCredential()).toMatchObject({ access: "fixture-access" });
	} finally {
		request.end();
		await pending;
		await route.dispose();
		login.mockRestore();
		await f.close();
	}
});

it("releases the login conflict after native logout fails without creating a latent login", async () => {
	const f = await nativeLogoutFixture();
	const signingOut = f.auth.signOut();
	const failure = expect(signingOut).rejects.toThrow("Credential store delete failed");
	try {
		await f.deletionEntered;
		await expect(f.auth.signIn("browser")).rejects.toThrow("sign-out is still completing");
		f.fail();
		await failure;
		expect(await f.auth.status()).toMatchObject({ status: "signed-in" });
		expect(await f.auth.status()).not.toHaveProperty("loginAttemptId");
		await f.auth.signIn("browser");
		const attemptId = (await f.auth.status()).loginAttemptId;
		await f.auth.submitCode("fixture-code", attemptId);
		await vi.waitFor(async () =>
			expect(await f.auth.status()).toMatchObject({ status: "signed-in", completedLoginAttemptId: attemptId }),
		);
		const accounts = await f.session.store.listAccounts();
		expect(accounts).toHaveLength(2);
		const credentials = await Promise.all(accounts.map((account) => f.session.store.readAccount(account.id)));
		expect(credentials).toContainEqual(expect.objectContaining({ access: "fixture-new-access" }));
	} finally {
		f.release();
		await failure;
		await f.close();
	}
});

it("rechecks an awaited method-switch cancellation when native logout begins before the new login starts", async () => {
	const f = await nativeLogoutFixture("codex");
	let releaseCancel: () => void = () => undefined;
	let enteredCancel: () => void = () => undefined;
	const cancelEntered = new Promise<void>((resolve) => {
		enteredCancel = resolve;
	});
	const cancelWait = new Promise<void>((resolve) => {
		releaseCancel = resolve;
	});
	const cancel = f.auth.cancel.bind(f.auth);
	const delayedCancel = vi.spyOn(f.auth, "cancel").mockImplementation(async () => {
		enteredCancel();
		await cancelWait;
		await cancel();
	});
	let signingOut: Promise<void> | undefined;
	let switched: Promise<void> | undefined;
	try {
		await f.auth.signIn("browser");
		switched = expect(f.auth.signIn("device")).rejects.toThrow("sign-out is still completing");
		await cancelEntered;
		signingOut = f.auth.signOut();
		await f.deletionEntered;
		releaseCancel();
		await switched;
		expect(await f.auth.status()).not.toHaveProperty("loginAttemptId");
		expect(await f.auth.status()).not.toHaveProperty("completedLoginAttemptId");
		f.release();
		await signingOut;
		expect(await f.session.status()).toEqual({ authenticated: false });
	} finally {
		releaseCancel();
		f.release();
		await Promise.all([switched, signingOut]);
		delayedCancel.mockRestore();
		await f.close();
	}
});

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
