import React from 'react';
import { forage } from '../../helpers';
import ErrorPage from './ErrorPage';

// ERROR BOUNDARY COMPONENT ---
// Robust wrapper to catch JavaScript errors in children components and provide fallback UI
class ErrorBoundary extends React.Component<any, any> {
	// COMPONENT INITIALIZATION ---
	constructor(props) {
		super(props);
		this.state = { hasError: false, error: null, errorInfo: null };
	}

	// ERROR STATE DERIVATION ---
	// Updates component state when an error is thrown in a child
	static getDerivedStateFromError(error) {
		return { hasError: true, error };
	}

	// ERROR LOGGING AND SIDE EFFECTS ---
	// Captures error details for debugging and reporting
	async componentDidCatch(error, errorInfo) {
		this.setState({ errorInfo });
		console.error('ErrorBoundary caught an error', error, errorInfo);

		try {
			// CONTEXT GATHERING ---
			const errorData = {
				message: error.message || error.toString(),
				stack: error.stack,
				componentStack: errorInfo.componentStack,
				timestamp: Date.now(),
				url: window.location.href,
				userAgent: navigator.userAgent,
			};

			// LOCAL STORAGE PERSISTENCE ---
			const errorId = `error_${Date.now()}`;
			await forage({ mode: 'set', what: errorId, val: errorData });

			// REMOTE SERVER REPORTING ---
			if (window.navigator.onLine) {
				try {
					fetch('/api/log-error', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(errorData),
						keepalive: true,
					}).catch(() => {});
				} catch {
					// Ignore errors in reporting to prevent loops
				}
			}
		} catch (storageError) {
			console.error('Failed to store error information', storageError);
		}
	}

	// RECOVERY HANDLER ---
	// Resets the error state to allow the user to try again
	handleReset = () => {
		this.setState({ hasError: false, error: null, errorInfo: null });
	};

	// COMPONENT RENDERING ---
	render() {
		if (this.state.hasError) {
			return (
				<ErrorPage
					error={this.state.error}
					errorInfo={this.state.errorInfo}
					onReset={this.handleReset}
				/>
			);
		}

		return this.props.children;
	}
}

export default ErrorBoundary;
