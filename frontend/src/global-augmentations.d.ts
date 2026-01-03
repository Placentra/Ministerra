// GLOBAL TYPE AUGMENTATIONS ------------------------------------------------------
// Steps: keep runtime globals and Axios internal config extensions type-safe enough to compile,
// without changing runtime behavior or weakening checks via ts-nocheck.

// MODULE AUGMENTATION IMPORTS ----------------------------------------------------
// Steps: ensure these declarations merge into real package types (not shadow them).
import 'axios';

// FILE MODULE MARKER -------------------------------------------------------------
// Steps: keep this file in module scope while still using `declare global`.
export {};

declare global {
	// WINDOW RUNTIME FLAGS -------------------------------------------------------
	// Steps: declare the app's runtime globals used for throttling, interceptor state, and wipe logic.
	interface Window {
		__wipeInProgress?: boolean;
		__throttleMap?: Map<string, Set<string>>;
		__dynamicScalingHandler?: ((event?: Event) => void) | null;
		__axiosInterceptorsInstalled?: { reqId: number; resId: number } | null;
		__showGlobalError?: any;
	}

	// DOM RELAXED EVENT TARGETS ---------------------------------------------------
	// Steps: many handlers in this codebase intentionally treat `event.target` as a specific input/element; allow common fields to reduce repetitive casts.
	interface EventTarget {
		value?: any;
		style?: any;
		src?: any;
	}

	// DOM RELAXED ELEMENT HELPERS --------------------------------------------------
	// Steps: some flows intentionally query generic `Element` and call members that exist on `HTMLElement`.
	interface Element {
		click?: () => void;
		offsetTop?: number;
	}

	// NAVIGATOR EXTENSIONS -------------------------------------------------------
	// Steps: some browsers expose deviceMemory; the app uses it for lightweight heuristics.
	interface Navigator {
		deviceMemory?: any;
	}
}

declare module 'axios' {
	// AXIOS REQUEST CONFIG EXTENSIONS -------------------------------------------
	// Steps: allow internal flags and timing fields used by interceptors.
	export interface AxiosRequestConfig<D = any> {
		__skipLogoutCleanup?: any;
		__skipGlobalErrorBanner?: any;
	}

	export interface InternalAxiosRequestConfig<D = any> {
		__throttle?: { urlKey: string; signature: string };
		__requestStart?: number;
	}
}
