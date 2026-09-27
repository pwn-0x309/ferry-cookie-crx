.PHONY: test e2e run

# Unit suite around the pure rewrite() + ETC v3 serializer (fixtures F1-F10).
test:
	node --test test/unit/*.test.js

# Playwright harness loading the unpacked extension into real Chrome and
# replaying F1/F3/F10 through the popup. Requires playwright:
#   cd test/e2e && npm install
# or point FC_PLAYWRIGHT_ROOT at a directory that already has it installed.
e2e:
	node test/e2e/run-e2e.mjs

# Opens chrome://extensions for the first manual load-unpacked of this folder
# (Chrome > Load unpacked > select ferry-cookie/).
run:
	@case "$$(uname -s)" in \
		Darwin) open -a "Google Chrome" "chrome://extensions/" ;; \
		*) xdg-open "chrome://extensions/" 2>/dev/null || echo "Open chrome://extensions/ in your browser, then Load unpacked from: $(CURDIR)" ;; \
	esac
