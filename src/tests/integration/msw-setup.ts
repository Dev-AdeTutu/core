/**
 * MSW setup for mocking wallet responses (#198).
 * 
 * This file sets up Mock Service Worker to intercept and mock
 * wallet adapter interactions for integration testing.
 */

import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

/**
 * Mock wallet state for testing.
 */
export interface MockWalletState {
  connected: boolean;
  publicKey: string | null;
  walletType: string;
}

/**
 * Mock wallet responses.
 */
const mockWalletState: MockWalletState = {
  connected: false,
  publicKey: null,
  walletType: "freighter",
};

/**
 * Reset mock wallet state to initial values.
 */
export function resetMockWalletState(): void {
  mockWalletState.connected = false;
  mockWalletState.publicKey = null;
  mockWalletState.walletType = "freighter";
}

/**
 * Set mock wallet state for testing.
 */
export function setMockWalletState(state: Partial<MockWalletState>): void {
  Object.assign(mockWalletState, state);
}

/**
 * MSW handlers for wallet operations.
 */
export const walletHandlers = [
  // Mock Freighter connect
  http.post("https://freighter.app/api/connect", async () => {
    if (mockWalletState.connected) {
      return HttpResponse.json({
        address: mockWalletState.publicKey,
      });
    }
    return HttpResponse.json(
      { error: "Wallet not connected" },
      { status: 400 },
    );
  }),

  // Mock Freighter disconnect
  http.post("https://freighter.app/api/disconnect", async () => {
    mockWalletState.connected = false;
    mockWalletState.publicKey = null;
    return HttpResponse.json({ success: true });
  }),

  // Mock Freighter sign transaction
  http.post("https://freighter.app/api/sign", async ({ request }) => {
    if (!mockWalletState.connected) {
      return HttpResponse.json(
        { error: "Wallet not connected" },
        { status: 400 },
      );
    }

    const body = await request.json() as { xdr: string };
    
    // Simulate user rejection
    if (body.xdr.includes("reject")) {
      return HttpResponse.json(
        { error: "User rejected transaction" },
        { status: 400 },
      );
    }

    // Simulate timeout
    if (body.xdr.includes("timeout")) {
      // Delay response to simulate timeout
      await new Promise((resolve) => setTimeout(resolve, 35000));
      return HttpResponse.json(
        { error: "Request timeout" },
        { status: 408 },
      );
    }

    // Simulate network error
    if (body.xdr.includes("network-error")) {
      return HttpResponse.json(
        { error: "Network error" },
        { status: 503 },
      );
    }

    // Return signed XDR (mock)
    return HttpResponse.json({
      signedXdr: body.xdr.replace("AAAA", "AAAB"), // Mock signature
    });
  }),

  // Mock Lobstr connect
  http.post("https://lobstr.co/api/connect", async () => {
    if (mockWalletState.connected) {
      return HttpResponse.json({
        address: mockWalletState.publicKey,
      });
    }
    return HttpResponse.json(
      { error: "Wallet not connected" },
      { status: 400 },
    );
  }),

  // Mock Lobstr sign transaction
  http.post("https://lobstr.co/api/sign", async ({ request }) => {
    if (!mockWalletState.connected) {
      return HttpResponse.json(
        { error: "Wallet not connected" },
        { status: 400 },
      );
    }

    const body = await request.json() as { xdr: string };
    return HttpResponse.json({
      signedXdr: body.xdr.replace("AAAA", "AAAB"),
    });
  }),
];

/**
 * MSW server instance.
 */
export const mswServer = setupServer(...walletHandlers);

/**
 * Start MSW server for testing.
 */
export function startMswServer(): void {
  mswServer.listen();
}

/**
 * Stop MSW server after testing.
 */
export function stopMswServer(): void {
  mswServer.close();
}

/**
 * Reset MSW handlers between tests.
 */
export function resetMswHandlers(): void {
  mswServer.resetHandlers();
}
