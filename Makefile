.PHONY: help up down build dev typecheck test deps-audit deps-update test-coverage test-watch test-visual test-visual-update test-touch test-e2e test-e2e-remote test-conformance server-screens server-test server-lint server-image logs ps clean

help:                ## list available targets
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z_-]+:.*##/ {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

up:                  ## start Obsidian + esbuild watch in the background
	docker compose up -d
	@echo ""
	@echo "  Obsidian GUI    https://localhost:3001  (accept self-signed cert)"
	@echo "  Player screen   http://localhost:3000   (once started from the DM panel)"
	@echo ""

down:                ## stop and remove containers
	docker compose down

build:               ## one-shot production build
	docker compose run --rm -e BUILD_OUT= builder sh -c "npm install --no-audit --no-fund && npm run build"

dev:                 ## run only the watcher (no Obsidian GUI)
	docker compose up builder

typecheck:           ## tsc --noEmit
	docker compose --profile tools run --rm typecheck

test:                ## vitest run
	docker compose --profile tools run --rm test

deps-audit:          ## dependency audit, runtime-only then including dev
	docker compose --profile tools run --rm deps "npm install --no-audit --no-fund >/dev/null 2>&1; echo '--- runtime only ---'; npm audit --omit=dev; echo '--- including dev ---'; npm audit"

deps-update:         ## re-resolve package-lock.json from package.json, then audit
	docker compose --profile tools run --rm deps "set -e; npm i -g npm@11 >/dev/null 2>&1 || echo 'warning: could not upgrade npm, using '\$$(npm --version); npm install --package-lock-only --no-audit --no-fund; npm install --no-audit --no-fund >/dev/null 2>&1; set +e; npm audit"

test-coverage:       ## vitest run --coverage (report in ./coverage/)
	docker compose --profile tools run --rm test sh -c "npm install --no-audit --no-fund && npx vitest run --coverage"

test-watch:          ## vitest in watch mode (interactive)
	docker compose --profile tools run --rm -e CI=0 test sh -c "npm install --no-audit --no-fund && npx vitest"

test-visual:         ## playwright visual regression (inside the official playwright image)
	docker compose --profile tools run --rm visual

test-visual-update:  ## refresh visual baselines (inside container — host PNGs WILL diff)
	docker compose --profile tools run --rm visual sh -c "npm install --no-audit --no-fund && npx playwright test --update-snapshots"

test-touch:          ## touch-gesture suite under real fingers (Chromium + WebKit tablet profiles)
	docker compose --profile tools run --rm visual sh -c "npm install --no-audit --no-fund && npx playwright test --project=touch-chromium --project=touch-webkit"

test-e2e:            ## real-Obsidian e2e suite (wdio; OBSIDIAN_VERSIONS=app/installer pairs, default latest/latest)
	docker compose --profile tools run --rm e2e

test-conformance:    ## black-box server contract (CONFORMANCE_TARGET=embedded|remote, default embedded)
ifeq ($(CONFORMANCE_TARGET),remote)
	docker compose --profile tools build conformance-remote
	docker compose --profile tools run --rm conformance-remote
else
	docker compose --profile tools run --rm conformance
endif

test-e2e-remote:     ## real-Obsidian remote-mode e2e against a fresh remote server container
	docker compose --profile tools up -d --build --force-recreate --renew-anon-volumes e2e-server
	E2E_SPEC=./test/e2e/specs/remote.e2e.ts DM_SCREEN_E2E_REMOTE_URL=http://dmscreen.local:8080 docker compose --profile tools run --rm e2e; \
	  status=$$?; docker compose --profile tools rm -sfv e2e-server >/dev/null; exit $$status

server-screens:      ## export the player/map screens into server/assets/ for the Rust build
	docker compose --profile tools run --rm deps "npm install --no-audit --no-fund >/dev/null 2>&1 && node scripts/export-screens.mjs server/assets"

server-test: server-screens  ## cargo test for the remote server
	docker compose --profile tools run --rm server cargo test --locked

server-lint: server-screens  ## rustfmt check + clippy (warnings are errors)
	docker compose --profile tools run --rm server sh -c "cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings"

server-image:        ## build the remote server container image (dm-screen-server:dev)
	docker build -f server/Dockerfile -t dm-screen-server:dev .

logs:                ## tail combined logs
	docker compose logs -f --tail=50

ps:                  ## container status
	docker compose ps

clean:               ## remove build artefacts and Obsidian local state (keeps vault notes)
	rm -rf node_modules main.js
	rm -rf .dev/vault/.obsidian/plugins/dm-screen .dev/vault/.obsidian/plugins/hot-reload
	rm -rf .dev/config
