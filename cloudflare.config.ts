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
			// Declared (not valued) so `cf deploy` preserves them — omitting a
			// secret from this block entirely is what wipes it on every deploy
			// (see README's Setup section for the full story). Values are set
			// out of band via `cf workers secrets bulk`, never here.
			GITHUB_APP_ID: bindings.secret(),
			GITHUB_APP_PRIVATE_KEY: bindings.secret(),
			GITHUB_APP_INSTALLATION_ID: bindings.secret(),
			GITHUB_OWNER: bindings.secret(),
			GITHUB_REPO: bindings.secret(),
			TARGET_URL: bindings.secret(),
			GITHUB_WEBHOOK_SECRET: bindings.secret(),
			RUN_TOKEN: bindings.secret(),
			// QA_GOAL (optional, §7) is deliberately NOT declared here:
			// bindings.secret() has no "optional" mode — every declared secret
			// becomes required, and `cf deploy` refuses to run at all if a
			// declared one isn't set. See README's Setup section for what that
			// means if you do set QA_GOAL.
		},
	},
});
