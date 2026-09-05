import { webcrypto } from "node:crypto";

import { vi } from "vitest";

vi.stubGlobal("window", {
	crypto: webcrypto,
	setTimeout: (...args) => globalThis.setTimeout(...args),
	clearTimeout: (...args) => globalThis.clearTimeout(...args),
});
