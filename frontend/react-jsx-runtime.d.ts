// JSX RUNTIME TYPE DECLARATION ---
// Provides type definitions for react/jsx-runtime when using experimental React versions
declare module 'react/jsx-runtime' {
	export function jsx(type: any, props: any, key?: any): any;
	export function jsxs(type: any, props: any, key?: any): any;
	export function Fragment(props: { children?: any }): any;
}

declare module 'react/jsx-dev-runtime' {
	export function jsxDEV(type: any, props: any, key?: any, isStaticChildren?: boolean, source?: any, self?: any): any;
}







