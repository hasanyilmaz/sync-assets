import { describe, expect, it } from "vitest";

import {
	HASH_COMPUTATION_STATUSES,
	INTEGRITY_STATUSES,
	RELEASE_ASSET_NAMES,
	type HashComputationStatus,
	type IntegrityStatus,
} from "../src/domain";

const STATUS_COVERAGE = {
	healthy: true,
	"repair-available": true,
	missing: true,
	mismatched: true,
	unsupported: true,
	unverifiable: true,
	error: true,
} satisfies Record<IntegrityStatus, true>;

const HASH_STATUS_COVERAGE = {
	"not-required": true,
	"not-computed": true,
	computed: true,
	error: true,
} satisfies Record<HashComputationStatus, true>;

describe("domain contracts", () => {
	it("keeps the release asset allowlist closed", () => {
		expect(RELEASE_ASSET_NAMES).toEqual([
			"main.js",
			"manifest.json",
			"styles.css",
		]);
	});

	it("has an exhaustive runtime entry for every integrity status", () => {
		expect(Object.keys(STATUS_COVERAGE)).toEqual(INTEGRITY_STATUSES);
	});

	it("has an exhaustive runtime entry for every hash computation status", () => {
		expect(Object.keys(HASH_STATUS_COVERAGE)).toEqual(HASH_COMPUTATION_STATUSES);
	});
});
