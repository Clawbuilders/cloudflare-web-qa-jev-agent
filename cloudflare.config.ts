import { bindings, defineConfig, triggers } from "cf/config";

/**
 * Secret-like files were detected but not read or migrated: .dev.vars.example. Only `secrets.required` entries are migrated.
 * @see https://developers.cloudflare.com/workers/configuration/secrets/
 */

export default defineConfig({
	worker: {
		name: "web-qa-jev-agent",
		compatibilityDate: "2025-09-01",
		compatibilityFlags: [
			"nodejs_compat",
		],
		entrypoint: "src/index.ts",
		observability: {
			enabled: true,
		},
		triggers: [
			triggers.scheduled({
				schedule: "0 14 1 * *",
			}),
		],
		env: {
			MAX_PAGES: bindings.text("10"),
			ESCALATION_FLOOR: bindings.text("0.6"),
			ISSUE_LABEL: bindings.text("web-qa-jev-agent"),
			ACTION_BUDGET: bindings.text("10"),
			CHROMIUM_ONLY_PATTERNS: bindings.text(""),
			REVISIT_RATE: bindings.text("0.3"),
			COVERAGE: bindings.kv({
				id: "2f782cdc2ba64ffb822e73f481cfe290",
			}),
			AI: bindings.ai({}),
			BROWSER: bindings.browser({}),
		},
	},
});
