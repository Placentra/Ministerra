// RELAXED TYPING OVERRIDES ------------------------------------------------------
// Steps: temporarily relax 3rd-party typing strictness (React hooks, router hooks, axios config)
// so the app compiles while the codebase is being incrementally re-typed.
//
// Important: this does NOT change runtime behavior; it only loosens compile-time checks.

// MODULE AUGMENTATION IMPORTS ---------------------------------------------------
// Steps: ensure TypeScript treats the `declare module '...'` blocks below as augmentations of *existing* package typings,
// not as stand-alone ambient module stubs (which can shadow real exports).
import 'react';
import 'react-router-dom';
import 'axios';

// REACT HOOKS OVERRIDES ---------------------------------------------------------
declare module 'react' {
	// HOOKS ---
	// Steps: return permissive `any` shapes to avoid cascading inference issues (useState inferred as `{}` / `undefined`, etc).
	// This is intentionally broad; tighten later with real generics once the codebase is stable.
	export function useState(initialState?: any): [any, any];
	export function useRef(initialValue?: any): any;
	export function useEffect(effect: any, deps?: any): void;
	export function useLayoutEffect(effect: any, deps?: any): void;
	export function useMemo(factory: any, deps?: any): any;
	export function useCallback(callback: any, deps?: any): any;

	// COMPONENT HELPERS ---
	export const memo: any;
	export const lazy: any;
	export const Suspense: any;
}

// REACT ROUTER HOOK OVERRIDES ---------------------------------------------------
declare module 'react-router-dom' {
	// ROUTER DATA + CONTEXT ---
	// Steps: router loader/context returns are dynamic in this app; treat them as `any` for now.
	export function useLoaderData(): any;
	export function useOutletContext(): any;
	export function useNavigate(): any;
	export function redirect(to: any): any;
}

// AXIOS CONFIG AUGMENTATION -----------------------------------------------------
declare module 'axios' {
	// Steps: allow internal config flags without fighting Axios types.
	export interface AxiosRequestConfig<D = any> {
		__skipLogoutCleanup?: any;
	}
}

// MODULE MARKER ----------------------------------------------------------------
// Steps: ensure the declarations above are treated as *module augmentations* (not ambient module stubs),
// so they merge into the real package typings instead of replacing them (which breaks exports like `useContext` / `RouterProvider`).
export {};


