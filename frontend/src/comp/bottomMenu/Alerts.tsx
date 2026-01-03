import { useEffect, useState, memo, useRef, useLayoutEffect } from 'react';
import axios from 'axios';
import useSocketIO from '../../hooks/useSocketIO';
import AlertStrip from '../contentStrips/AlertStrip';
import Masonry from '../Masonry';
import useMasonResize from '../../hooks/useMasonResize';
import { forage } from '../../../helpers';
import { linksHandler } from '../../hooks/useLinksAndBlocks';
import { notifyGlobalError } from '../../hooks/useErrorsMan';

// INFO: Uses newest fetched alert time to rate-limit fetches (1 min cooldown)

/** ----------------------------------------------------------------------------
 * ALERTS COMPONENT
 * Displays user notifications in a bottom drawer with cursor-based pagination.
 * Handles fetching, socket updates, local storage sync, and UI state.
 * -------------------------------------------------------------------------- */
function Alerts(props) {
	// PROPS & STATE -----------------------------------------------------------
	const { brain, setNotifDots, notifDots, menuView, setMenuView, showToast } = props;
	const storedAlerts = brain.user.alerts || {};
	const storedData = Array.isArray(storedAlerts.data) ? storedAlerts.data : [];
	const [alertsData, setAlertsData] = useState(storedData);
	const shouldFetch = !storedData.length || notifDots.alerts > 0 || !storedAlerts.lastFetch || Date.now() - storedAlerts.lastFetch > 1000 * 60;

	const cursors = useRef(!shouldFetch && storedAlerts.cursors ? storedAlerts.cursors : ['new', 0]);
	const [ui, setUi] = useState({ loading: false, error: null });
	const [nothingMore, setNothingMore] = useState(false);
	const fetchInProg = useRef(false);
	const lastFetch = useRef(0);
	const processedAlertIds = useRef(new Set());
	const wrapperRef = useRef(null);
	const [stripMenu, setStripMenu] = useState(null); // AlertStrip menu state

	// SOCKET IO INTEGRATION ---------------------------------------------------
	useSocketIO({
		setAlertsData,
		thisIs: 'alerts',
		brain,
		setNotifDots,
		menuView,
		setMenuView,
		showToast,
	});

	// LOCAL DATA SYNC ---------------------------------------------------------
	// Updates connection status (accept/link/refuse) locally based on alerts
	async function updateLocalDataFromAlertStrip(alerts = []) {
		try {
			for (const a of alerts) {
				if (!a || !a.id || processedAlertIds.current.has(a.id)) continue;
				if (['link', 'accept', 'refuse'].includes(a.what)) {
					const id = a?.data?.user ?? a?.target;
					if (id != null) {
						try {
							await linksHandler({ mode: a.what, id, brain, isSocket: true, direct: a?.data?.dir, note: a?.data?.note, message: a?.data?.message });
						} catch {
							/* ignore */
						}
					}
				}
				processedAlertIds.current.add(a.id);
			}
		} catch {
			/* ignore */
		}
	}

	async function storeAlertsData() {
		try {
			const val = { data: alertsData, cursors: cursors.current, lastFetch: Date.now(), notifDots: { ...notifDots, alerts: 0 } };
			await forage({ mode: 'set', what: 'alerts', val });
		} catch {
			/* ignore */
		}
	}

	// EFFECTS -----------------------------------------------------------------

	// FETCH & SEEN STATUS LOGIC ---
	const prevMenuView = useRef(menuView);
	const alertsDataRef = useRef(alertsData);
	alertsDataRef.current = alertsData;

	useEffect(() => {
		// Update last seen alert ID when closing alerts view
		if (prevMenuView.current === 'alerts' && menuView !== 'alerts') {
			const currentAlerts = alertsDataRef.current;
			if (currentAlerts?.length) {
				const validIds = currentAlerts.filter(a => a.id).map(a => Number(a.id));
				if (validIds.length) {
					const highestId = Math.max(...validIds);
					if (highestId > (brain.user.lastSeenAlert || 0)) {
						brain.user.lastSeenAlert = highestId;
						forage({ mode: 'set', what: 'user', val: brain.user });
					}
				}
			}
		}
		prevMenuView.current = menuView;

		if (menuView !== 'alerts' || fetchInProg.current) return;
		if (shouldFetch) fetchAlerts();
	}, [menuView]);

	// RESTORE STRIP MENU STATE ---
	useLayoutEffect(() => {
		if (brain.restoreStripMenu && menuView === 'alerts') setStripMenu(brain.restoreStripMenu), delete brain.restoreStripMenu;
	}, [menuView]);

	// FETCH ALERTS ------------------------------------------------------------
	// Handles bidirectional cursor fetching (newest/oldest) and merges data
	async function fetchAlerts() {
		try {
			fetchInProg.current = true;
			setUi({ loading: true, error: null });
			const [syncMode, cursor] = Array.isArray(cursors.current) ? cursors.current : ['new', 0];
			const sortedCopy = [...alertsData].sort((a, b) => b.id - a.id);
			const firstPrevStoredID = syncMode === 'new' ? sortedCopy.find(alert => alert.id < cursor)?.id : undefined;
			const lastID = syncMode === 'old' ? sortedCopy[sortedCopy.length - 1]?.id : undefined;

			// SERVER REQUEST ---
			const newAlerts =
				(
					await axios.post('/alerts', {
						mode: 'getAlerts',
						cursor: syncMode === 'new' ? cursor : undefined,
						lastID: syncMode === 'old' ? lastID : undefined,
						firstID: firstPrevStoredID,
					})
				).data || [];

			await updateLocalDataFromAlertStrip(newAlerts);

			// UPDATE CURSORS ---
			const lowestAlertId = newAlerts[newAlerts.length - 1]?.id || cursor || 0;
			const intersected = alertsData.find(alert => alert.id >= lowestAlertId);
			if (newAlerts.length < 20) {
				if (syncMode === 'old') {
					cursors.current = 'gotAll';
					setNothingMore(true);
					setTimeout(() => setNothingMore(false), 2000);
				} else {
					const nextCursor = !intersected ? lowestAlertId : Math.min(intersected.id, lastID || lowestAlertId);
					cursors.current = ['old', nextCursor];
				}
			} else {
				cursors.current = [syncMode === 'new' && intersected ? 'old' : syncMode, !intersected ? lowestAlertId : Math.min(intersected.id, lastID || lowestAlertId)];
			}

			// MERGE & DEDUPLICATE ---
			const sourceAlerts = syncMode === 'new' ? [...newAlerts, ...alertsData] : [...alertsData, ...newAlerts];
			const buildAlertKey = a => {
				const userKey = a?.data?.user || `${a?.data?.first || ''}${a?.data?.last || ''}`;
				const eveKey = a?.data?.title || '';
				const contentKey = (a?.data?.content || '').slice(0, 20);
				if (a?.what === 'interest') {
					const countsKey = a?.data?.sur || a?.data?.may || a?.data?.int ? `${a?.data?.sur || 0},${a?.data?.may || 0},${a?.data?.int || 0}` : `${Date.now()}`;
					return `${a?.what}:${a?.target}:${countsKey}:${userKey}:${eveKey}:${contentKey}`;
				}
				if (/(?:^|_)rating$/.test(a?.what)) {
					const pts = a?.data?.points ?? a?.data?.counts ?? 0;
					return `${a?.what}:${a?.target}:${pts}:${userKey}:${eveKey}:${contentKey}`;
				}
				return `${a?.what}:${a?.target}:${userKey}:${eveKey}:${contentKey}`;
			};

			const byContent = new Map();
			const preserveKeys = ['flag', 'refused', 'accepted', 'linked', 'inter', 'interPriv'];
			for (const a of sourceAlerts) {
				const k = buildAlertKey(a);
				const prev = byContent.get(k);
				if (!prev) {
					byContent.set(k, a);
				} else {
					const aId = Number(a?.id || 0);
					const pId = Number(prev?.id || 0);
					const base = aId >= pId ? { ...a } : { ...prev };
					const other = aId >= pId ? prev : a;
					for (const key of preserveKeys) {
						if ((base[key] === null || base[key] === undefined) && other[key] !== null && other[key] !== undefined) base[key] = other[key];
					}
					byContent.set(k, base);
				}
			}
			const mergedAlerts = Array.from(byContent.values()).sort((a, b) => Number(b.id) - Number(a.id));
			await forage({ mode: 'set', what: 'alerts', val: { data: mergedAlerts, cursors: cursors.current, lastFetch: Date.now(), notifDots: { ...notifDots, alerts: 0 } } });
			(lastFetch.current = Date.now()), setAlertsData(mergedAlerts), setNotifDots({ ...notifDots, alerts: 0 });
		} catch (error) {
			notifyGlobalError(error, 'Nepodařilo se načíst upozornění.');
			setUi({ loading: false, error: true });
		} finally {
			fetchInProg.current = false;
			setUi(prev => ({ ...prev, loading: false }));
		}
	}

	// HELPERS -----------------------------------------------------------------

	function removeAlert(alertId) {
		try {
			setAlertsData(prev => {
				const next = Array.isArray(prev) ? prev.map(a => (a.id === alertId ? {} : a)) : [];
				brain.user.alerts ??= {};
				brain.user.alerts.data = next;
				brain.user.alerts.cursors = brain.user.alerts.cursors || cursors.current;
				brain.user.alerts.lastFetch = brain.user.alerts.lastFetch || Date.now();
				forage({ mode: 'set', what: 'alerts', val: brain.user.alerts });
				return next;
			});
		} catch {
			/* ignore */
		}
	}

	function onStripClick(alert) {
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
				const title = data?.event?.title || '';
				const slug = encodeURIComponent(title).replace(/\./g, '-').replace(/%20/g, '_');
				window.location.href = `/event/${target}!${slug}#discussion`;
			},
			comment: () => {
				window.location.href = `/event/${data.event || target}#discussion`;
			},
			reply: () => {
				window.location.href = `/event/${data.event || target}#discussion`;
			},
		};
		actions[what]?.();
	}

	// RENDER PREP -------------------------------------------------------------
	const [numOfCols] = useMasonResize({ wrapper: wrapperRef, brain, contType: 'alertStrips', deps: [alertsData?.length], contLength: alertsData?.length || 0 });

	const lastSeenAlert = brain.user.lastSeenAlert || 0;
	const validAlerts = (alertsData || []).filter(a => a.id);
	const newAlerts = validAlerts.filter(a => Number(a.id) > lastSeenAlert).sort((a, b) => Number(b.id) - Number(a.id));
	const olderAlerts = validAlerts.filter(a => Number(a.id) <= lastSeenAlert).sort((a, b) => Number(b.id) - Number(a.id));

	// RENDER ------------------------------------------------------------------
	return (
		<alerts-wrapper ref={wrapperRef} class={`${menuView !== 'alerts' ? 'hide' : ''} block bgWhite hvh100 mhvh100 w100 overAuto bInsetBlueDark flexCol justEnd`}>
			{/* NEW ALERTS SECTION --- */}
			{newAlerts.length > 0 && (
				<>
					<section-title class={`flexCol block borBotLight textAli marTopXl`}>
						<span className='fs12 inlineBlock tetSha marAuto xBold w100'>Nová upozornění</span>
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
								storeAlertsData={storeAlertsData}
								stripMenu={stripMenu}
								setStripMenu={setStripMenu}
							/>
						))}
						config={{ contType: 'alertStrips', numOfCols: numOfCols, noPadTop: true }}
						brain={brain}
					/>
				</>
			)}

			{/* OLDER ALERTS SECTION --- */}
			{olderAlerts.length > 0 && (
				<>
					<section-title class={`flexCol block borBotLight textAli ${newAlerts.length > 0 ? 'marTopL' : 'marTopXl'}`}>
						<span className='fs12 inlineBlock tetSha marAuto xBold w100'>Starší upozornění</span>
						<blue-divider class={` hr0-5 borTop marTopXs  block bInsetBlueTopXl  bgTrans  w90  mw140   marAuto   `} />
					</section-title>
					<Masonry
						content={olderAlerts.map(a => (
							<AlertStrip
								key={a.id}
								alert={a}
								brain={brain}
								storeAlertsData={storeAlertsData}
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

			{/* LOAD MORE BUTTON --- */}
			{(nothingMore || (alertsData?.length && alertsData?.length % 20 === 0 && cursors.current !== 'gotAll')) && (
				<button
					onClick={() => !nothingMore && fetchAlerts()}
					className={` ${
						nothingMore
							? 'tBlue borRed fsD xBold'
							: ui.loading
							? 'bBlue tWhite'
							: ui.error
							? 'bRed tWhite'
							: 'borRed thickBors posRel xBold bInsetBlueTop zinMaXl bDarkBlue  borBot8 tWhite'
					} w80 marAuto  fs10 mw80 padVerXs  shaTop  textSha marBotS marTopM`}>
					{nothingMore ? 'Nic dalšího už není' : ui.loading ? 'Načítám...' : ui.error ? 'Chyba při načítání' : 'Načíst další výsledky'}
				</button>
			)}
			<empty-div class='hr16 block' />
		</alerts-wrapper>
	);
}

function dontRerender(prevProps, nextProps) {
	return prevProps.menuView === nextProps.menuView && prevProps.notifDots === nextProps.notifDots && prevProps.brain.user.alerts === nextProps.brain.user.alerts;
}

export default memo(Alerts, dontRerender);
