/**
 * Entry point for the prebuilt `<script>` bundle, for apps with no bundler of
 * their own. Everything the module exports lands on `window.OnePatchRum`.
 */

import * as rum from "./index.js";

declare global {
	interface Window {
		OnePatchRum: typeof rum;
	}
}

window.OnePatchRum = rum;
