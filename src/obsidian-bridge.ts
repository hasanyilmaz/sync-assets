import type {
	RequestUrlParam,
	RequestUrlResponse,
} from "obsidian";

import type { RemoteHttpClient } from "./remote-release";

export type ObsidianRequestSender = (
	request: RequestUrlParam,
) => Promise<RequestUrlResponse>;

interface ObsidianCommandHost {
	readonly commands?: {
		readonly executeCommandById?: (commandId: string) => unknown;
	};
}

export function createRemoteHttpClient(
	send: ObsidianRequestSender,
): RemoteHttpClient {
	return async request => {
		const response = await send({
			url: request.url,
			method: request.method,
			headers: { ...request.headers },
			throw: request.throw,
		});
		return {
			status: response.status,
			headers: { ...response.headers },
			arrayBuffer: response.arrayBuffer,
			text: response.text,
		};
	};
}

export function executeObsidianAppReload(app: unknown): boolean {
	const commands = (app as ObsidianCommandHost | null)?.commands;
	const execute = commands?.executeCommandById;
	if (typeof execute !== "function") {
		return false;
	}
	try {
		return execute.call(commands, "app:reload") !== false;
	} catch {
		return false;
	}
}
