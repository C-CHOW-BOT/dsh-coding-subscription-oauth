import type { AuthInteraction } from "@earendil-works/pi-ai";
import { expect, it, vi } from "vitest";
import { SubscriptionWebAuth } from "../src/auth-routes.ts";
import { OAUTH_PROVIDER_DEFINITIONS } from "../src/oauth-providers.ts";

function fixture() {
	let finish: () => void = () => undefined;
	let fail: (error: Error) => void = () => undefined;
	let authorizeUrl = "https://claude.ai/oauth/authorize?state=fixture";
	const session = {
		definition: OAUTH_PROVIDER_DEFINITIONS.find((definition) => definition.slug === "claude")!,
		availableModels: () => [{ id: "model" }],
		selectedModelIds: () => ["model"],
		visibleModels: () => [{ id: "model" }],
		store: {
			listAccounts: async () => [{ id: "existing" }],
			getActiveAccountId: async () => "existing",
		},
		status: async () => ({ authenticated: true }),
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
