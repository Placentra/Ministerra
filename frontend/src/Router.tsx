// ROUTING CONFIGURATION ---
// Defines the application's route structure using React Router's data APIs.
import { createBrowserRouter, Navigate, useLocation } from 'react-router-dom';
import React, { Suspense, lazy } from 'react';

// LAZY LOADED COMPONENTS ---
const Foundation = lazy(() => import('./mainSections/Foundation'));
const Event = lazy(() => import('./mainSections/Event'));
const Setup = lazy(() => import('./mainSections/Setup'));
const Editor = lazy(() => import('./mainSections/Editor'));
const Entrance = lazy(() => import('./mainSections/Entrance'));

// LOADER UTILITIES ---
import { eventLoader } from './loaders/eventLoader';
import { setupLoader } from './loaders/setupLoader';
import { editorLoader } from './loaders/editorLoader';

// EDITOR REMOUNTER ---
// Ensures Editor component re-mounts on pathname changes to reset internal state.
function EditorPathnameRemounter() {
	const location = useLocation();
	return (
		<Suspense fallback={<div></div>}>
			{/* DYNAMIC EDITOR INSTANCE --- */}
			<Editor key={location.pathname} />
		</Suspense>
	);
}

// MAIN ROUTER FACTORY ---
// Generates the router instance with brain and foundationLoader context.
const Router = ({ brain, foundationLoader }) =>
	createBrowserRouter([
		{
			// ROOT FOUNDATION ROUTE ---
			loader: async ({ request }) => {
				const url = new URL(request.url);
				return foundationLoader({ url: url.toString(), brain });
			},
			path: '/',
			element: (
				<Suspense fallback={<div></div>}>
					<Foundation />
				</Suspense>
			),
			children: [
				{
					// EVENT DETAIL ROUTE ---
					path: 'event/:eventID',
					loader: async ({ params }) => eventLoader(brain, params),
					element: (
						<Suspense fallback={<div></div>}>
							<Event />
						</Suspense>
					),
				},
				{
					// USER SETUP ROUTE ---
					path: 'setup',
					loader: async () => setupLoader(brain),
					element: (
						<Suspense fallback={<div></div>}>
							<Setup />
						</Suspense>
					),
				},
				{
					// CONTENT EDITOR ROUTE ---
					path: 'editor/:eventID?',
					loader: async ({ params = {} }) => editorLoader(brain, params),
					element: <EditorPathnameRemounter />,
				},
				// CATCH-ALL REDIRECT ---
				{ path: '*', element: <Navigate to='/entrance' replace /> },
			],
		},
		{
			// AUTHENTICATION ENTRANCE ROUTE ---
			path: '/entrance',
			element: (
				<Suspense fallback={<div></div>}>
					<Entrance brain={brain} />
				</Suspense>
			),
		},
		{
			// TOP-LEVEL CATCH-ALL ---
			// Redirects any unmatched route to entrance (safest default for unauthenticated users).
			path: '*',
			element: <Navigate to='/entrance' replace />,
		},
	]);

export default Router;
