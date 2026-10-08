/** @vitest-environment jsdom */
import { waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { finishClaudeBridgeReturn, mountClaudeBridgeReturn, takeClaudeBridgeReturn } from "../src/client/claude-bridge-return.tsx";
import type { jsonRequest } from "../src/client/api.ts";
import { LOGIN_CODE_PATH, STATUS_PATH } from "../src/client/constants.ts";
import { en } from "../src/client/locales.ts";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/client/api.ts", async () => ({ ...await vi.importActual("../src/client/api.ts"), jsonRequest: mocks.request }));
const challenge = "https://claude.ai/oauth/authorize?state=pending-state&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback";
const callback = "http://localhost:53692/callback?code=fixture-code&state=pending-state";
const pending = { status: "signing-in", method: "browser", url: challenge };
const status = (claude: unknown) => ({ providers: { claude } });
const cleanups: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose(); vi.restoreAllMocks(); mocks.request.mockReset(); window.history.replaceState(null, "", "/"); });

it("removes the callback fragment before any request and consumes it only once", () => {
	window.history.replaceState({ fixture: true }, "", `/?session=fixture#${new URLSearchParams({ "dsh-claude-callback": callback })}`);
	expect(takeClaudeBridgeReturn(window.location, window.history)).toBe(callback);
	expect(window.location.hash).toBe("");
	expect(window.location.search).toBe("?session=fixture");
	expect(window.history.state).toEqual({ fixture: true });
	expect(takeClaudeBridgeReturn(window.location, window.history)).toBeUndefined();
	expect(mocks.request).not.toHaveBeenCalled();
});

it("clears duplicate or oversized payloads but preserves unrelated fragments", () => {
	window.history.replaceState(null, "", "#dsh-claude-callback=a&dsh-claude-callback=b");
	expect(takeClaudeBridgeReturn(window.location, window.history)).toBe("");
	expect(window.location.hash).toBe("");
	window.history.replaceState(null, "", `#dsh-claude-callback=${"x".repeat(8193)}`);
	expect(takeClaudeBridgeReturn(window.location, window.history)).toBe("");
	expect(window.location.hash).toBe("");
	window.history.replaceState(null, "", "#unrelated");
	expect(takeClaudeBridgeReturn(window.location, window.history)).toBeUndefined();
	expect(window.location.hash).toBe("#unrelated");
});

it("submits a matching callback once and waits beyond POST acceptance for persisted signed-in state", async () => {
	const controller = new AbortController();
	let confirmed = false;
	const request = vi.fn(async (path: string) => path === LOGIN_CODE_PATH ? { ok: true } : status(confirmed ? { status: "signed-in" } : pending));
	const wait = vi.fn(async () => { confirmed = true; });
	await finishClaudeBridgeReturn(callback, controller.signal, { request: request as typeof jsonRequest, wait });
	expect(request.mock.calls.filter(([path]) => path === STATUS_PATH)).toHaveLength(3);
	expect(request.mock.calls.filter(([path]) => path === LOGIN_CODE_PATH)).toHaveLength(1);
	expect(request).toHaveBeenCalledWith(LOGIN_CODE_PATH, "POST", { provider: "claude", code: callback }, controller.signal);
	expect(wait).toHaveBeenCalledOnce();
});

it.each([
	status({ ...pending, url: challenge.replace("pending-state", "another-state") }),
	status({ status: "signed-in" }),
	status({ ...pending, method: "device" }),
	status({ ...pending, url: challenge.replace("claude.ai", "example.com") }),
])("rejects a stale or unrelated pending login before submission", async (initial) => {
	const request = vi.fn(async () => initial);
	await expect(finishClaudeBridgeReturn(callback, new AbortController().signal, { request: request as typeof jsonRequest, wait: vi.fn() })).rejects.toThrow();
	expect(request).toHaveBeenCalledOnce();
});

it("does not report success when native exchange fails after accepting the callback", async () => {
	let reads = 0;
	const request = vi.fn(async (path: string) => path === LOGIN_CODE_PATH ? { ok: true } : status(++reads === 1 ? pending : { status: "error" }));
	await expect(finishClaudeBridgeReturn(callback, new AbortController().signal, { request: request as typeof jsonRequest, wait: vi.fn() })).rejects.toThrow("did not complete");
});

it("bounds polling and stops without resubmitting a code when canceled", async () => {
	const request = vi.fn(async (path: string) => path === LOGIN_CODE_PATH ? { ok: true } : status(pending));
	await expect(finishClaudeBridgeReturn(callback, new AbortController().signal, { request: request as typeof jsonRequest, wait: vi.fn(async () => {}) })).rejects.toThrow("timed out");
	expect(request.mock.calls.filter(([path]) => path === LOGIN_CODE_PATH)).toHaveLength(1);
	const controller = new AbortController();
	request.mockClear();
	await expect(finishClaudeBridgeReturn(callback, controller.signal, { request: request as typeof jsonRequest, wait: async () => { controller.abort(); } })).rejects.toThrow("stopped");
	expect(request.mock.calls.filter(([path]) => path === LOGIN_CODE_PATH)).toHaveLength(1);
});

it("renders generic recovery text without reflecting callback codes or provider errors", async () => {
	mocks.request.mockRejectedValue(new Error(`upstream error ${callback}`));
	cleanups.push(mountClaudeBridgeReturn(callback, (key) => en[key]));
	await waitFor(() => expect(document.body.textContent).toContain(en.bridgeReturnFailure));
	expect(document.body.textContent).not.toContain("fixture-code");
	expect(document.body.textContent).not.toContain("pending-state");
	expect(document.body.textContent).not.toContain(en.bridgeReturnSuccess);
});
