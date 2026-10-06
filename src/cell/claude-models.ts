import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

/**
 * Models that reach Claude with the owner's subscription. pi-ai treats an `sk-ant-oat` token in ANTHROPIC_OAUTH_TOKEN
 * as OAuth and sends the Claude Code identity; the token is fetched from the account cell for every request.
 */
export function claudeModels(accessToken: () => Promise<string>): Models {
	const models = createModels({
		authContext: {
			env: async (name) => (name === "ANTHROPIC_OAUTH_TOKEN" ? accessToken() : undefined),
			fileExists: async () => false,
		},
	});
	models.setProvider(anthropicProvider());
	return models;
}
