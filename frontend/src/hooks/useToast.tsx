import { useState, useCallback, useEffect, useRef } from 'react';
import AlertStrip from '../comp/contentStrips/AlertStrip';

// TODO add action buttons to toasts, so that user doesn´t have to navigate anywhere.

export function ToastStrip() {
	return null;
}

/** ----------------------------------------------------------------------------
 * USE TOAST HOOK
 * Manages a queue of toast notifications, displaying them one by one.
 * Renders an absolute overlay for the active toast.
 * -------------------------------------------------------------------------- */
function useToast(_opts?: any) {
	const [toast, setToast] = useState(null);
	const [isToastActive, setIsToastActive] = useState(false);
	const toastQueue = useRef([]);
	const processingQueue = useRef(false);

	const processNextToast = useCallback(() => {
		if (processingQueue.current) return;
		processingQueue.current = true;

		if (toastQueue.current.length === 0) {
			processingQueue.current = false;
			return;
		}

		if (!isToastActive) {
			const nextToast = toastQueue.current.shift();
			displayToast(nextToast);
		}

		processingQueue.current = false;
	}, [isToastActive]);

	// Display the toast
	const displayToast = useCallback(
		({ alert, brain, placement = 'top', timeout = 8000, onToastClick = () => {} }) => {
			setIsToastActive(true);

			// absolute overlay covering app content but not blocking nav
			setToast(
				<toast-wrapper
					style={{
						position: 'fixed',
						width: 'fit-content',
						zIndex: 10000,
						pointerEvents: 'auto',
						...(placement === 'top' && { top: '40px', left: '50%', transform: 'translateX(-50%)' }),
						...(placement === 'bottom' && { bottom: '20px', left: '50%', transform: 'translateX(-50%)' }),
						...(placement === 'center' && { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }),
					}}>
					<AlertStrip alert={alert} brain={brain} onClick={() => (onToastClick as any)(alert)} isToast={true} />
				</toast-wrapper>
			);

			// Clear toast after timeout and process next in queue
			setTimeout(() => {
				setToast(null), setIsToastActive(false), setTimeout(processNextToast, 100);
			}, timeout);
		},
		[processNextToast]
	);

	useEffect(() => {
		const intervalId = setInterval(() => processNextToast(), 1000);
		return () => clearInterval(intervalId);
	}, [processNextToast]);

	const showToast = useCallback(
		toastConfig => {
			toastQueue.current.push(toastConfig);
			processNextToast();
		},
		[processNextToast]
	);
	return { toast, showToast };
}

export default useToast;
