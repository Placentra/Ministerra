import { useEffect, useState, memo, useRef, useLayoutEffect, useCallback } from 'react';
import axios from 'axios';
import useSocketIO from '../../hooks/useSocketIO';
import AlertStrip from '../contentStrips/AlertStrip';
import Masonry from '../Masonry';
import useMasonResize from '../../hooks/useMasonResize';
import { forage } from '../../../helpers';
import { linksHandler } from '../../hooks/useLinksAndBlocks';
import { notifyGlobalError } from '../../hooks/useErrorsMan';

/** ----------------------------------------------------------------------------
 * ALERTS COMPONENT (REVISED)
 * Displays user notifications in a bottom drawer.
 * Handles fetching with robust cursor-based pagination.
 * -------------------------------------------------------------------------- */
function Alerts(props) {
	// PROPS & STATE -----------------------------------------------------------
	const { brain, setNotifDots, notifDots, menuView, setMenuView, showToast } = props;

	// Initialize state from brain/storage
	const [alertsData, setAlertsData] = useState(() => {
		const stored = brain.user.alerts;
		return stored && Array.isArray(stored.data) ? stored.data : [];
	});

	// Separate pagination state
	const [pagination, setPagination] = useState(() => {
		const stored = brain.user.alerts?.pagination;
		// Default to hasMore: true to allow initial fetch if nothing stored
		return stored || { hasMore: true, oldCursor: null, newCursor: null };
	});

	const [ui, setUi] = useState({ loading: false, error: null });
	const fetchInProg = useRef(false);
	const wrapperRef = useRef(null);
	const [stripMenu, setStripMenu] = useState(null);
	const processedAlertIds = useRef(new Set());

	// SOCKET IO ---------------------------------------------------------------
	useSocketIO({
		setAlertsData,
		thisIs: 'alerts',
		brain,
		setNotifDots,
		menuView,
		setMenuView,
		showToast,
	});

	// PERSISTENCE & SYNC ------------------------------------------------------
	const saveToStorage = useCallback(
		async (data, pag) => {
			try {
				// Limit stored alerts to 100 to prevent bloat, as requested
				const limitedData = data.slice(0, 100);
				const val = {
					data: limitedData,
					pagination: pag,
					lastFetch: Date.now(),
					notifDots: { ...notifDots, alerts: 0 },
					// Maintain legacy cursor field for compatibility
					cursors: pag.oldCursor ? ['old', pag.oldCursor] : ['new', 0],
				};
				brain.user.alerts = val;
				await forage({ mode: 'set', what: 'alerts', val });
			} catch (e) {
				console.error('Failed to save alerts:', e);
			}
		},
		[brain, notifDots]
	);

	// Sync local actions (link/accept) from alerts content
	const updateLocalDataFromAlertStrip = useCallback(
		async (alerts = []) => {
			try {
				for (const a of alerts) {
					if (!a || !a.id || processedAlertIds.current.has(a.id)) continue;
					if (['link', 'accept', 'refuse'].includes(a.what)) {
						const id = a?.data?.user ?? a?.target;
						if (id != null) {
							linksHandler({
								mode: a.what,
								id,
								brain,
								isSocket: true,
								direct: a?.data?.dir,
								note: a?.data?.note,
								message: a?.data?.message,
							}).catch(() => {});
						}
					}
					processedAlertIds.current.add(a.id);
				}
			} catch {
				/* ignore */
			}
		},
		[brain]
	);

	// KEY BUILDER FOR DEDUPLICATION -------------------------------------------
	const buildAlertKey = useCallback(a => {
		// Priority 1: Use unique ID if available. This ensures we show exactly what the backend sends (20 items = 20 items).
		if (a.id) return `id:${a.id}`;
		
		// Fallback (mostly for socket events before they are persisted/fetched with ID, though typically they have IDs too)
		const userKey = a?.data?.user || `${a?.data?.first || ''}${a?.data?.last || ''}`;
		const eveKey = a?.data?.title || '';
		const contentKey = (a?.data?.content || '').slice(0, 20);
		
		// Interest alerts might still benefit from merging if they are purely count updates
		if (a?.what === 'interest') {
			const countsKey = a?.data?.sur || a?.data?.may || a?.data?.int ? `${a?.data?.sur || 0},${a?.data?.may || 0},${a?.data?.int || 0}` : `${Date.now()}`;
			return `${a?.what}:${a?.target}:${countsKey}:${userKey}:${eveKey}:${contentKey}`;
		}
		
		return `${a?.what}:${a?.target}:${userKey}:${eveKey}:${contentKey}`;
	}, []);

	// FETCHING LOGIC ----------------------------------------------------------
	const fetchAlerts = useCallback(
		async (mode = 'init') => {
			if (fetchInProg.current) return;
			fetchInProg.current = true;
			setUi(prev => ({ ...prev, loading: true, error: null }));

			try {
				// Determine request params
				const body: { mode: string; limit: number; cursor?: number; firstID?: number } = { mode: 'getAlerts', limit: 20 };

				if (mode === 'older') {
					if (pagination.oldCursor) body.cursor = pagination.oldCursor;
				} else if (mode === 'newer') {
					if (pagination.newCursor) body.firstID = pagination.newCursor;
				}
				// 'init' sends no cursor/firstID (fetches latest)

				const res = await axios.post('/alerts', body);
				const rawData = Array.isArray(res.data) ? res.data : res.data.data || [];
				const meta = !Array.isArray(res.data) ? res.data.pagination : { hasMore: rawData.length >= 20, nextCursor: rawData.length ? rawData[rawData.length - 1].id : null };

				await updateLocalDataFromAlertStrip(rawData);

				// MERGE DATA SYNCHRONOUSLY ------------------------------------
				const byKey = new Map();
				const preserveKeys = ['flag', 'refused', 'accepted', 'linked', 'inter', 'interPriv'];

				const processItem = item => {
					const k = buildAlertKey(item);
					const prev = byKey.get(k);
					if (!prev) {
						byKey.set(k, item);
					} else {
						// Merge logic: prefer newer ID, preserve local state flags
						const base = item.id >= prev.id ? { ...item } : { ...prev };
						const other = item.id >= prev.id ? prev : item;
						for (const key of preserveKeys) {
							if (base[key] == null && other[key] != null) base[key] = other[key];
						}
						byKey.set(k, base);
					}
				};

				// 1. Add ALL existing items to map first
				alertsData.forEach(processItem);

				// 2. Add ALL new items to map
				rawData.forEach(processItem);

				// 3. Convert back to array and sort by ID DESC
				const mergedAlerts = Array.from(byKey.values()).sort((a, b) => Number(b.id) - Number(a.id));

				// CALCULATE PAGINATION SYNCHRONOUSLY --------------------------
				const updatedPagination = { ...pagination };

				if (mode === 'init') {
					updatedPagination.hasMore = meta.hasMore;
					updatedPagination.oldCursor = meta.nextCursor;
					if (rawData.length > 0) {
						const maxId = Math.max(...rawData.map(r => Number(r.id)));
						updatedPagination.newCursor = maxId;
					}
				} else if (mode === 'older') {
					updatedPagination.hasMore = meta.hasMore;
					updatedPagination.oldCursor = meta.nextCursor;
				} else if (mode === 'newer') {
					if (rawData.length > 0) {
						const maxId = Math.max(...rawData.map(r => Number(r.id)));
						updatedPagination.newCursor = Math.max(updatedPagination.newCursor || 0, maxId);
					}
				}

				// UPDATE STATE & STORAGE --------------------------------------
				setAlertsData(mergedAlerts);
				setPagination(updatedPagination);
				saveToStorage(mergedAlerts, updatedPagination);

				// Reset Notif Dots if we fetched new stuff
				if (mode === 'init' || mode === 'newer') {
					setNotifDots(prev => ({ ...prev, alerts: 0 }));
				}
			} catch (err) {
				console.error(err);
				notifyGlobalError(err, 'Nepodařilo se načíst upozornění.');
				setUi(prev => ({ ...prev, error: true }));
			} finally {
				fetchInProg.current = false;
				setUi(prev => ({ ...prev, loading: false }));
			}
		},
		[pagination, brain, notifDots, saveToStorage, buildAlertKey, updateLocalDataFromAlertStrip, setNotifDots, alertsData]
	);

	// INITIAL LOAD ------------------------------------------------------------
	const prevMenuView = useRef(menuView);

	useEffect(() => {
		if (menuView !== 'alerts') {
			if (prevMenuView.current === 'alerts') {
				// User is leaving alerts view
				if (alertsData.length) {
					const maxId = Math.max(...alertsData.map(a => Number(a.id)));
					if (maxId > (brain.user.lastSeenAlert || 0)) {
						brain.user.lastSeenAlert = maxId;
						forage({ mode: 'set', what: 'user', val: brain.user });
					}
				}
			}
			prevMenuView.current = menuView;
			return;
		}
		prevMenuView.current = menuView;

		// Check if we need to fetch
		const lastFetch = brain.user.alerts?.lastFetch || 0;
		const stale = Date.now() - lastFetch > 1000 * 60; // 1 min cache
		const hasNew = notifDots.alerts > 0;
		const empty = alertsData.length === 0;

		if ((stale || hasNew || empty) && !fetchInProg.current) {
			fetchAlerts(hasNew || !empty ? 'newer' : 'init');
		}
	}, [menuView, fetchAlerts, alertsData, brain, notifDots.alerts]);

	// RESTORE STRIP MENU ------------------------------------------------------
	useLayoutEffect(() => {
		if (brain.restoreStripMenu && menuView === 'alerts') {
			setStripMenu(brain.restoreStripMenu);
			delete brain.restoreStripMenu;
		}
	}, [menuView, brain]);

	// HELPER ACTIONS ----------------------------------------------------------
	const removeAlert = useCallback(
		alertId => {
			setAlertsData(prev => {
				const next = prev.filter(a => a.id !== alertId);
				saveToStorage(next, pagination);
				return next;
			});
		},
		[saveToStorage, pagination]
	);

	const onStripClick = useCallback(
		alert => {
			const { what, target, data = {} } = alert;
			const actions = {
				invite: () => ((brain.showGalleryCat = 'invites'), setMenuView('gallery')),
				link: () => ((brain.showGalleryCat = 'links'), setMenuView('gallery')),
				accept: () => ((brain.showGalleryCat = 'links'), setMenuView('gallery')),
				interest: () => {
					const title = data.title || '';
					const slug = encodeURIComponent(title).replace(/\./g, '-').replace(/%20/g, '_');
					window.location.href = `/event/${target}!${slug}#discussion`;
				},
				comm_rating: () => {
					window.location.href = `/event/${data.event || target}#discussion`;
				},
				eve_rating: () => {
					const title = data?.title || '';
					const slug = encodeURIComponent(title).replace(/\./g, '-').replace(/%20/g, '_');
					window.location.href = `/event/${target}!${slug}#discussion`;
				},
				user_rating: () => {
					window.location.href = `/user/${brain.user.id}`;
				},
				comment: () => {
					window.location.href = `/event/${data.event || target}#discussion`;
				},
				reply: () => {
					window.location.href = `/event/${data.event || target}#discussion`;
				},
			};
			actions[what]?.();
		},
		[brain, setMenuView]
	);

	// RENDER PREP -------------------------------------------------------------
	const [numOfCols] = useMasonResize({
		wrapper: wrapperRef,
		brain,
		contType: 'alertStrips',
		deps: [alertsData.length],
		contLength: alertsData.length,
	});

	const lastSeenAlert = brain.user.lastSeenAlert || 0;
	// Filter out invalid alerts (e.g. empty objects from removal if any)
	const validAlerts = alertsData.filter(a => a && a.id);
	const newAlerts = validAlerts.filter(a => Number(a.id) > lastSeenAlert);
	const olderAlerts = validAlerts.filter(a => Number(a.id) <= lastSeenAlert);

	return (
		<alerts-wrapper ref={wrapperRef} class={`${menuView !== 'alerts' ? 'hide' : ''} block bgWhite hvh100 mhvh100 w100 overAuto bInsetBlueDark flexCol justEnd`}>
			{/* NEW ALERTS */}
			{newAlerts.length > 0 && (
				<>
					<section-title class={`flexCol block borBotLight textAli marTopXl`}>
						<span className="fs22 inlineBlock tetSha marAuto xBold w100">Nová upozornění</span>
						<blue-divider class={` hr0-5 borTop marTopXs  block bInsetBlueTopXl  bgTrans  w90  mw140   marAuto   `} />
					</section-title>
					<Masonry
						content={newAlerts.map(a => (
							<AlertStrip
								key={a.id}
								alert={a}
								brain={brain}
								menuView={menuView}
								onClick={() => onStripClick(a)}
								onRemoveAlert={() => removeAlert(a.id)}
								setMenuView={setMenuView}
								storeAlertsData={() => saveToStorage(alertsData, pagination)}
								stripMenu={stripMenu}
								setStripMenu={setStripMenu}
							/>
						))}
						config={{ contType: 'alertStrips', numOfCols: numOfCols, noPadTop: true }}
						brain={brain}
					/>
				</>
			)}

			{/* OLDER ALERTS */}
			{olderAlerts.length > 0 && (
				<>
					<section-title class={`flexCol block borBotLight textAli ${newAlerts.length > 0 ? 'marTopL' : 'marTopXl'}`}>
						<span className="fs18 inlineBlock tetSha marAuto xBold w100">Starší upozornění</span>
						<blue-divider class={` hr0-5 borTop marTopXs  block bInsetBlueTopXl  bgTrans  w90  mw140   marAuto   `} />
					</section-title>
					<Masonry
						content={olderAlerts.map(a => (
							<AlertStrip
								key={a.id}
								alert={a}
								brain={brain}
								storeAlertsData={() => saveToStorage(alertsData, pagination)}
								menuView={menuView}
								onClick={() => onStripClick(a)}
								onRemoveAlert={() => removeAlert(a.id)}
								setMenuView={setMenuView}
								stripMenu={stripMenu}
								setStripMenu={setStripMenu}
							/>
						))}
						config={{ contType: 'alertStrips', numOfCols: numOfCols, noPadTop: true }}
						brain={brain}
					/>
				</>
			)}

			{/* LOAD MORE BUTTON */}
			{/* Always show if hasMore is true, unless loading */}
			{(pagination.hasMore || ui.loading) && (
				<button
					onClick={() => !ui.loading && fetchAlerts('older')}
					className={` ${!pagination.hasMore ? 'tBlue borRed fsD xBold' : ui.loading ? 'bBlue tWhite' : ui.error ? 'bRed tWhite' : ' thickBors posRel xBold  zinMaXl bInsetBlueTopXs bBor2   '} w80 marAuto  fs10 mw60 padVerXxs  shaTop  textSha marBotS marTopM`}
				>
					{!pagination.hasMore ? 'Nic dalšího už není' : ui.loading ? 'Načítám...' : ui.error ? 'Chyba při načítání' : 'Načíst další výsledky'}
				</button>
			)}
			<empty-div class="hr16 block" />
		</alerts-wrapper>
	);
}

function dontRerender(prevProps, nextProps) {
	return prevProps.menuView === nextProps.menuView && prevProps.notifDots === nextProps.notifDots && prevProps.brain.user.alerts === nextProps.brain.user.alerts;
}

export default memo(Alerts, dontRerender);
