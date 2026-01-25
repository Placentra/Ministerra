// INTERACTIVE MAP COMPONENT ---
// Renders an interactive map using MapLibre GL for discovering events and friendlyMeetings.
// Handles clustering, custom markers, viewport sync with filters, and event previews.
import { useLayoutEffect, useRef, useState, memo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { notifyGlobalError } from '../hooks/useErrorsMan';
import { humanizeDateTime, getFilteredContent, areEqual } from '../../helpers';
import { getDistance } from '../utils/locationUtils';
import EventCard from '../comp/EventCard.tsx';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// todo UPLOAD ICONS TO MAPBOX AND USE THEM INSTEAD OF PNGS AS symbol layer
// USE NOMINATIM for geolocations (don´t need seznam at all, requires own server)

function MapLibre(props: any) {
	// PROPS AND STATE INITIALIZATION ------------------------------------------
	const { show, map, nowAt, showMan, brain, sherData, snap, avail, setSnap, singleEvent } = props,
		[zoom, setZoom] = useState({ zoomIn: () => {}, zoomOut: () => {}, fitMap: () => {} }),
		[zoomLimits, setZoomLimits] = useState({ min: 0, max: 18, current: 0 }),
		inited = useRef<any>(null),
		mapContainer = useRef<any>(null),
		mapInstanceRef = useRef<any>(null),
		mapMarkersArr = useRef<any>(null),
		features = useRef<any>(null),
		snapItems = useRef<any>(null),
		mapVisibilityRef = useRef<any>(null),
		[, setRecalc] = useState(0),
		updateDebounce = useRef(null),
		prevMapVisibility = useRef(map),
		clusterEventsRef = useRef<any[]>([]);

	// REFS AND NAVIGATION ---------------------------
	mapVisibilityRef.current = map;
	const navigate = useNavigate();

	// MAP REGENERATION TRIGGER ------------------------------------------------
	// Re-calculates features and markers when filters or event selection change.
	useEffect(() => {
		(features.current = null), generateMap();
	}, [snap?.types, avail?.types, singleEvent]);

	// MAP GENERATION CORE LOGIC -----------------------------------------------
	// Orchestrates map initialization, data sourcing, and layer management.
	async function generateMap() {
		try {
			let mapBox = mapInstanceRef.current;
			// DETERMINE DATA SOURCE ---------------------------
			if (singleEvent) {
				snapItems.current = [singleEvent];
			} else {
				// Pull filtered data based on active search/filter criteria ---------------------------
				snapItems.current = getFilteredContent({ what: 'content', brain, snap, avail, sherData, show, isForMap: true });
				brain.itemsOnMap = snapItems.current.map(event => event.id).sort((a, b) => a - b);
			}

			const eventsMap = new Map(snapItems.current.map(event => [event.id, event]));
			brain.totalMapContent = eventsMap.size;

			// VIEWPORT UPDATE HANDLER -----------------------------------------
			// Checks which events are currently within the map boundaries.
			function updateVisibleEvents() {
				const bounds = mapBox.getBounds();
				brain.itemsOnMap = snapItems.current
					.filter(event => event.lat && bounds.contains([event.lng, event.lat]))
					.map(event => event.id)
					.sort((a, b) => a - b);

				const currentMapVisibility = mapVisibilityRef.current;
				if (!singleEvent) {
					// SYNC SNAPSHOT STATE ---------------------------
					// Manages 'changed' flag to trigger re-fetches when map viewport desyncs from feed.
					if (currentMapVisibility === true) delete brain.stillShowingMapContent, delete brain.snapChangedWhileMapHidden;
					else if (
						currentMapVisibility !== true &&
						currentMapVisibility !== prevMapVisibility.current &&
						brain.lastFetchMapIDs &&
						brain.lastFetchMapIDs?.length !== brain.totalMapContent &&
						!snap?.changed
					)
						brain.stillShowingMapContent = true;

					const allowFetch =
						brain.snapChangedWhileMapHidden || brain.stillShowingMapContent
							? true
							: currentMapVisibility !== true
							? !brain.lastFetchMapIDs
								? false
								: brain.totalMapContent !== brain.itemsOnMap.length
							: !brain.lastFetchMapIDs
							? brain.itemsOnMap.length !== brain.totalMapContent
							: !areEqual(brain.lastFetchMapIDs, brain.itemsOnMap);
					setSnap?.(prev => ({ ...prev, changed: allowFetch }));
				}

				(prevMapVisibility.current = currentMapVisibility), setRecalc(prev => prev + 1);
			}

			// BOUNDS ADJUSTMENT -----------------------------------------------
			// Centers and zooms map to include all currently visible events.
			function fitMapToBounds() {
				if (snapItems.current.length === 0) return;

				const bounds = new maplibregl.LngLatBounds();
				for (const event of snapItems.current) {
					if (event.lat && event.lng) {
						bounds.extend([event.lng, event.lat]);
					}
				}

				if (singleEvent) {
					mapBox.flyTo({ center: [singleEvent.lng, singleEvent.lat], zoom: 14, duration: 0 });
				} else {
					mapBox.fitBounds(bounds, { padding: 100 });
				}
			}

			// GEOJSON FEATURE GENERATION --------------------------------------
			// Converts raw event data into GeoJSON format for MapLibre rendering.
			function getFeatures() {
				features.current = [];
				for (const event of snapItems.current) {
					if (event.lat && event.lng) {
						features.current.push({
							type: 'Feature',
							properties: event,
							geometry: { type: 'Point', coordinates: [event.lng, event.lat] },
						});
					}
				}
				return features.current;
			}

			// SOURCE SYNC ---------------------------
			async function updateMapSource() {
				if (mapBox.getSource('events')) {
					await mapBox.getSource('events').setData({ type: 'FeatureCollection', features: features.current || getFeatures() });
					createCustomMarkers(), updateVisibleEvents();
				}
			}

			// INTERACTION HANDLERS --------------------------------------------
			// Processes clicks on individual event markers to show previews.
			// clusterEvents: optional array of events in the same cluster for thumbnail switching
			async function markerClick(eve, clusterEvents: any[] = []) {
				if (brain.eventPopup) return delete brain.eventPopup, (clusterEventsRef.current = []), setRecalc(prev => prev + 1);
				const event = brain.events[eve.id];
				// ENSURE DATA AVAILABILITY ---------------------------
				if (!event.state.includes('basi')) {
					try {
						const { eventData } = (await axios.post('event', { eventID: event.id, getBasiOnly: true })).data;
						Object.assign(event, { ...eventData, state: event.state.includes('Deta') ? 'basiDeta' : 'basi' });
					} catch (err) {
						notifyGlobalError(err, 'Nepodařilo se načíst podrobnosti události.');
						return;
					}
				}
				window.scrollTo({ top: mapContainer.current.getBoundingClientRect().top + window.scrollY - 50, behavior: 'smooth' });
				clusterEventsRef.current = clusterEvents;
				(brain.eventPopup = event), setRecalc(prev => prev + 1);
			}

			// CUSTOM MARKER FACTORY -------------------------------------------
			// Generates HTML-based markers with type icons and time labels.
			function createCustomMarkers() {
				mapMarkersArr.current ??= [];
				const maxUsers = Math.max(...snapItems.current.map(event => 3 * event.surely + event.maybe || 0));

				// DYNAMIC SIZING BASED ON POPULARITY ---------------------------
				const calculateMarkerSize = guests => {
					const ratio = !maxUsers ? 0 : guests / maxUsers;
					const size = singleEvent ? 30 : 30 + ratio * (60 - 30);
					return size;
				};

				// STYLE CONFIGURATIONS ---------------------------
				const labelStyle = {
					textAlign: 'center',
					backgroundColor: '#1c7fd6',
					color: 'white',
					cursor: 'pointer',
					fontWeight: '700',
					padding: '0px 5px',
					verticalAlign: 'middle',
					opacity: '0.8',
					lineHeight: '1.6rem',
					borderRadius: '2px',
					display: 'inline-block',
					maxHeight: '1.6rem',
					fontSize: '10px',
					textShadow: '0px 0px 2px blue',
					fontFamily: 'Barlow',
					whiteSpace: 'nowrap',
				};
				const arrowStyle = { width: '0', height: '0', borderLeft: '7px solid transparent', borderRight: '7px solid transparent', borderTop: '8px solid #1c7fd6', position: 'relative' };
				const containerStyle = { display: 'flex', flexDirection: 'column', alignItems: 'center', transform: 'translateY(-50%)' };

				function createMarker(event) {
					const markerSize = calculateMarkerSize(3 * event.surely + event.maybe || 1);
					const containerElement = document.createElement('div');
					Object.assign(containerElement.style, containerStyle);
					containerElement.id = `marker_${event.id}`;
					containerElement.addEventListener('click', async e => (e.stopPropagation(), await markerClick(event)));

					const markerElement = document.createElement('img');
					markerElement.classList.add('hoverLarger');
					markerElement.src = `/icons/types/${event.type}.png`;
					Object.assign(markerElement.style, { width: `${markerSize + 0.4 * markerSize}px`, height: `${markerSize}px`, cursor: 'pointer', position: 'relative' });

					// SHADOW ELEMENT ---------------------------
					const bgcircle = document.createElement('div');
					Object.assign(bgcircle.style, {
						position: 'relative',
						zIndex: '-1',
						width: `${0.3 * markerSize + 0.1 * markerSize}px`,
						height: `${0.3 * markerSize}px`,
						top: `${0.7 * markerSize}px`,
						borderRadius: '50%',
						backgroundColor: '#ffffff',
						boxShadow: '0px 2px 20px 5px rgba(0, 0, 0, 0.22)',
					});

					const arrowElement = document.createElement('div');
					Object.assign(arrowElement.style, arrowStyle);

					const labelElement = document.createElement('div');
					labelElement.textContent = `${humanizeDateTime({ dateInMs: event.starts, hideFarTime: true })}`;
					Object.assign(labelElement.style, labelStyle);

					[bgcircle, markerElement, labelElement, arrowElement].forEach(el => containerElement.appendChild(el));
					const marker = new maplibregl.Marker({ element: containerElement }).setLngLat([event.lng, event.lat]).addTo(mapBox);
					return marker;
				}

				// SYNC MARKERS WITH CURRENT RENDERED FEATURES --------------------
				const existingMarkers = new Map();
				for (const marker of mapMarkersArr.current) {
					try {
						if (marker && marker._element && marker._element.id) {
							const id = marker._element.id.replace('marker_', '');
							existingMarkers.set(id, marker);
						}
					} catch (err) {
						console.error('Error accessing marker element', err);
					}
				}

				if (singleEvent) {
					mapMarkersArr.current.forEach(marker => marker.remove());
					mapMarkersArr.current = [createMarker(singleEvent)];
					return;
				}

				// CLEAR ALL MARKERS IF NO ITEMS ---
				if (!snapItems.current?.length) {
					mapMarkersArr.current.forEach(marker => marker.remove());
					mapMarkersArr.current = [];
					return;
				}

				const renderedUnclustered = mapBox.queryRenderedFeatures(undefined, { layers: ['unclustered-events'] });
				const newMarkerIds = new Set(renderedUnclustered.map(feature => feature.properties.id));

				const retainedMarkers = [];
				for (const [id, marker] of existingMarkers.entries()) {
					if (!newMarkerIds.has(id)) marker.remove();
					else {
						retainedMarkers.push(marker);
						newMarkerIds.delete(id);
					}
				}

				for (const id of newMarkerIds) {
					const event = eventsMap.get(id);
					if (event) {
						const marker = createMarker(event);
						retainedMarkers.push(marker);
					}
				}

				mapMarkersArr.current = retainedMarkers;
			}

			// MAP INITIALIZATION ----------------------------------------------
			// Creates a new MapLibre instance if not already existing.
			if (!mapInstanceRef.current) {
				const initialCoords = singleEvent ? [singleEvent.lng, singleEvent.lat] : brain.cities.find(city => city.cityID == brain.user.cities[0]);
				const centerLng = singleEvent ? singleEvent.lng : initialCoords.lng;
				const centerLat = singleEvent ? singleEvent.lat : initialCoords.lat;

				mapBox = new maplibregl.Map({
					container: mapContainer.current,
					style: 'https://tiles.openfreemap.org/styles/bright',
					center: [centerLng, centerLat],
					zoom: singleEvent ? 13 : 0,
					maxZoom: 18,
				});

				mapBox.scrollZoom.disable();

				mapBox.on('load', () => {
					// DATA SOURCE CONFIG ---------------------------
					// clusterMaxZoom set to max map zoom to prevent unclustering overlapping events at any zoom
					mapBox.addSource('events', {
						type: 'geojson',
						data: { type: 'FeatureCollection', features: getFeatures() },
						cluster: !singleEvent,
						clusterMaxZoom: 18,
						clusterRadius: 80,
					});

					// CLUSTER LAYERS ----------------------------------------------
					if (!singleEvent) {
						// MAIN BUBBLE ---------------------------
						mapBox.addLayer({
							id: 'clusters',
							type: 'circle',
							source: 'events',
							filter: ['has', 'point_count'],
							paint: {
								'circle-radius': ['step', ['get', 'point_count'], 20, 10, 30, 20, 40],
								'circle-color': ['step', ['get', 'point_count'], '#33c851', 10, '#0ba0e0', 20, '#003881'],
								'circle-opacity': 0.6,
								'circle-stroke-width': 2,
								'circle-stroke-color': '#ffffff',
								'circle-stroke-opacity': 0.7,
							},
						});

						// COUNT TEXT ---------------------------
						mapBox.addLayer({
							id: 'cluster-count',
							type: 'symbol',
							source: 'events',
							filter: ['has', 'point_count'],
							layout: { 'text-allow-overlap': true, 'text-field': '{point_count_abbreviated}', 'text-font': ['Noto Sans Bold'], 'text-size': 13 },
							paint: { 'text-color': '#ffffff' },
						});

						// HIDDEN UNCLUSTERED (MARKERS HANDLE THESE) ---------------------------
						mapBox.addLayer({
							id: 'unclustered-events',
							type: 'circle',
							source: 'events',
							filter: ['!', ['has', 'point_count']],
							paint: { 'circle-radius': 1, 'circle-opacity': 0 },
						});
					}

					// ADJUST STYLE OPACITY FOR BETTER VISIBILITY ------------------
					mapBox.getStyle().layers.forEach(layer => {
						if (layer.paint?.['background-color']) mapBox.setPaintProperty(layer.id, 'background-opacity', 0.3);
						if (layer.paint?.['fill-color']) mapBox.setPaintProperty(layer.id, 'fill-opacity', 0.3);
						if (layer.paint?.['line-color']) mapBox.setPaintProperty(layer.id, 'line-opacity', 0.6);
					});

					// CLUSTER POPUP LOGIC -----------------------------------------
					// Handles clicking on clusters to expand or show overlapping markers.
					if (!singleEvent) {
						mapBox.on('click', 'clusters', async e => {
							if (brain.eventPopup) return delete brain.eventPopup, setRecalc(prev => prev + 1);
							const features = mapBox.queryRenderedFeatures(e.point, { layers: ['clusters'] });
							const clusterId = features[0].properties.cluster_id;
							const expansionZoom = await mapBox.getSource('events').getClusterExpansionZoom(clusterId);
							const leaves = await mapBox.getSource('events').getClusterLeaves(clusterId, Infinity, 0);
							const markers = leaves.map(({ geometry: { coordinates }, properties: { id, type, starts } }) => ({ coordinates, id, type, starts }));

							// Check if all events are at the exact same coordinate ---------------------------
							let allWithinRadius = true;
							for (let i = 0; i < markers.length; i++) {
								for (let j = i + 1; j < markers.length; j++) {
									let distance = getDistance(markers[i].coordinates[1], markers[i].coordinates[0], markers[j].coordinates[1], markers[j].coordinates[0]);
									if (distance > 0.01) {
										allWithinRadius = false;
										break;
									}
								}
								if (!allWithinRadius) break;
							}

							if (allWithinRadius) {
								// STEP 1: SHOW MAPLIBRE POPUP WITH THUMBNAILS ---------------------------
								const clusterEvents = markers.map(marker => brain.events[marker.id]);

								// GENERATE POPUP HTML FOR OVERLAPPING EVENTS ---------------------------
								function generatePopupHTML({ starts, type, inter, id }) {
									const [upper, lower] = [humanizeDateTime({ dateInMs: starts, thumbRow: 'upper' }), humanizeDateTime({ dateInMs: starts, thumbRow: 'bottom' })];
									const interChip =
										inter === 'sur'
											? `<span class='bDarkGreen flexCen fs6 xBold boRadXxs bold padVerXxxxs padHorXxs tWhite marTopXxs'>určitě</span>`
											: inter === 'may'
											? `<span class='bBlue boldS fs6 flexCen boRadXxs padVerXxxxs tWhite marTopXxs'>možná</span>`
											: '';
									return `<event-thumb id="eveMapThumbnail_${id}" class="flexInline bgWhite bHover padAllXs pointer shaLight posRel boRadXs bgTransXxs justStart"><img class='miw5 mw5 marRigS boRadXs' src="/icons/types/${type}.png" alt='' /><texts-wrapper class='flexCol justStart aliStart'><span class="${
										inter === 'sur' ? 'tGreen' : 'tBlue'
									} textSha boldM fsD lh1">${upper}</span><span class='boldXs tNoWrap fsA lh1 marTopXxxs'>${lower}</span>${interChip}</texts-wrapper></event-thumb>`;
								}

								const html = clusterEvents.map(event => generatePopupHTML(event)).join('');
								const cols = Math.min(clusterEvents.length, 3);
								const popup = new maplibregl.Popup({ className: 'fitContent noPoint transparent', maxWidth: 'none' })
									.setLngLat(features[0].geometry.coordinates)
									.setHTML(
										`<thumbs-wrapper style="display:grid; grid-template-columns:repeat(${cols}, 1fr); gap:8px; padding:8px;" class="boRadXs zinMax posRel">${html}</thumbs-wrapper>`
									);

								// STEP 2 TRIGGER: on thumbnail click, show React thumbnail row + EventCard ---------------------------
								popup.on('open', () => {
									clusterEvents.forEach(event => {
										const element = document.getElementById(`eveMapThumbnail_${event.id}`);
										if (element)
											element.addEventListener('click', async e => {
												e.stopPropagation();
												popup.remove();
												clusterEventsRef.current = clusterEvents;
												await markerClick(event, clusterEvents);
											});
									});
								});
								popup.addTo(mapBox);
							}
							mapBox.flyTo({ center: features[0].geometry.coordinates, zoom: expansionZoom + (allWithinRadius ? -1 : 1) });
						});
					}

					// INTERACTION EVENT LISTENERS -------------------------------------
					mapBox.on('click', () => (brain.eventPopup || clusterEventsRef.current.length > 0) && (delete brain.eventPopup, (clusterEventsRef.current = []), setRecalc(prev => prev + 1)));
					['clusters', 'unclustered-events'].forEach(layer => {
						mapBox.on('mouseenter', layer, () => (mapBox.getCanvas().style.cursor = 'pointer'));
						mapBox.on('mouseleave', layer, () => (mapBox.getCanvas().style.cursor = ''));
					});

					// VIEWPORT SYNC ---------------------------
					if (!singleEvent) {
						mapBox.on('moveend', () => {
							if (!inited.current) (inited.current = true), updateMapSource();
							else clearTimeout(updateDebounce.current), (updateDebounce.current = setTimeout(() => updateMapSource(), 200));
							if (show?.sherlock) setSnap?.(prev => ({ ...prev }));
						});
					}

					setZoom({ zoomIn: () => mapBox.zoomIn(), zoomOut: () => mapBox.zoomOut(), fitMap: () => fitMapToBounds() });
					const syncZoom = () => setZoomLimits({ min: mapBox.getMinZoom(), max: mapBox.getMaxZoom(), current: mapBox.getZoom() });
					mapBox.on('zoom', syncZoom);
					syncZoom();
					mapInstanceRef.current = mapBox;
					if (singleEvent) createCustomMarkers();
					else fitMapToBounds();
				});
			} else await updateMapSource(), singleEvent ? null : fitMapToBounds();
		} catch (err) {
			console.error(err);
		}
	}

	// RESIZE AND BOUNDS SYNC --------------------------------------------------
	// Ensures map layers are correctly positioned after visibility changes.
	useEffect(() => {
		if (map === true && mapInstanceRef.current && snapItems.current?.length > 0 && brain.snapChangedWhileMapHidden) {
			const mapBox = mapInstanceRef.current;
			requestAnimationFrame(() => {
				mapBox.resize();
				const bounds = new maplibregl.LngLatBounds();
				for (const event of snapItems.current) if (event.lat && event.lng) bounds.extend([event.lng, event.lat]);
				mapBox.fitBounds(bounds, { padding: 100 });
			});
		}
	}, [map]);

	// AUTO-SCROLL TO MAP ------------------------------------------------------
	// Automatically focuses map when it becomes active or for specific event views.
	useEffect(() => {
		if (map === true && (singleEvent || mapContainer.current.getBoundingClientRect().bottom < window.scrollY)) {
			mapContainer.current.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
		}
	}, [map, singleEvent]);

	// CLUSTER THUMBNAIL CLICK HANDLER -------------------------------------------
	// Switches to a different event within the same cluster
	async function handleClusterThumbnailClick(event) {
		if (!event.state.includes('basi')) {
			try {
				const { eventData } = (await axios.post('event', { eventID: event.id, getBasiOnly: true })).data;
				Object.assign(event, { ...eventData, state: event.state.includes('Deta') ? 'basiDeta' : 'basi' });
			} catch (err) {
				notifyGlobalError(err, 'Nepodařilo se načíst podrobnosti události.');
				return;
			}
		}
		(brain.eventPopup = event), setRecalc(prev => prev + 1);
	}

	// RENDER MAP UI -----------------------------------------------------------
	return (
		<map-libre class={`${map === 'hide' ? 'hide' : singleEvent ? 'hvh50' : 'hvh80'} ${show?.filter || singleEvent ? 'marTopXs' : 'marTopXxl'}   shaTop  posRel marAuto boRadS block zinMax  `}>
			{/* HIDE MAP OVERLAY ----------------------------------------------------- */}
			{map === true && (show?.filter || show?.history) && !singleEvent && (
				<button onClick={() => showMan('map')} className='posAbs bgTransXs   tDarkBlue zinMenu topCen padAllXs boldM fs20 borTop  w40 marAuto mw30'>
					<span className='xBold tRed fs8'>Skrýt mapu</span>
				</button>
			)}

			{/* CLUSTER POPUP CONTAINER ----------------------------------------------- */}
			{/* Wraps thumbnails row + EventCard in vertical stack - only show when eventPopup is set (step 2) */}
			{brain.eventPopup && nowAt === 'home' && !singleEvent && (
				<cluster-popup
					onClick={e => e.target === e.currentTarget && (delete brain.eventPopup, (clusterEventsRef.current = []), setRecalc(prev => prev + 1))}
					class='posAbs topCen zinMenu flexCol aliCen w100 overHidden'
					style={{ maxHeight: '95%' }}>
					{/* CLUSTER EVENT THUMBNAILS ROW --- */}
					{clusterEventsRef.current.length > 1 && brain.eventPopup && (
						<cluster-thumbs
							onClick={e => e.target === e.currentTarget && (delete brain.eventPopup, (clusterEventsRef.current = []), setRecalc(prev => prev + 1))}
							class='flexRow gapXs  boRadXs wrap justCen w100 shrink0'>
							{clusterEventsRef.current.map(event => {
								const isSelected = brain.eventPopup?.id === event.id;
								const [upper, lower] = [humanizeDateTime({ dateInMs: event.starts, thumbRow: 'upper' }), humanizeDateTime({ dateInMs: event.starts, thumbRow: 'bottom' })];
								return (
									<event-thumb
										key={event.id}
										onClick={e => (e.stopPropagation(), handleClusterThumbnailClick(event))}
										class={`flexInline bHover padAllXs pointer shaLight posRel boRadXs justStart ${
											isSelected ? 'bDarkBlue arrowDown1 tWhite zinMaXl bsContentGlow' : 'bgWhite bgTransXxs'
										}`}>
										{/* TYPE ICON --- */}
										<img className='miw5 mw5 marRigS boRadXs' src={`/icons/types/${event.type}.png`} alt='' />
										{/* DATE/TIME TEXTS --- */}
										<texts-wrapper class='flexCol justStart aliStart'>
											<span className={`${isSelected ? 'tWhite' : event.inter === 'sur' ? 'tGreen' : 'tBlue'} textSha boldM fsD lh1`}>{upper}</span>
											<span className={`${isSelected ? 'tWhite' : ''} boldXs tNoWrap fsA lh1 marTopXxxs`}>{lower}</span>
											{/* ATTENDANCE CHIPS --- */}
											{!isSelected && event.inter === 'sur' && <span className='bDarkGreen flexCen fs6 xBold boRadXxs bold padVerXxxxs padHorXxs tWhite marTopXxs'>určitě</span>}
											{!isSelected && event.inter === 'may' && <span className='bBlue boldS fs6 flexCen boRadXxs padVerXxxxs tWhite marTopXxs'>možná</span>}
										</texts-wrapper>
									</event-thumb>
								);
							})}
						</cluster-thumbs>
					)}

					{/* EVENT PREVIEW POPUP --- */}
					{brain.eventPopup && (
						<scroll-wrapper
							onClick={e => e.target === e.currentTarget && (delete brain.eventPopup, (clusterEventsRef.current = []), setRecalc(prev => prev + 1))}
							class='overAuto w100 flexCol aliCen grow'>
							<EventCard isMapPopUp={true} brain={brain} nowAt={nowAt} obj={brain.eventPopup} />
						</scroll-wrapper>
					)}
				</cluster-popup>
			)}

			<map-canvas ref={mapContainer} class='h100 block posRel w100' />

			{/* INTERACTIVE CONTROLS ------------------------------------------------- */}
			<map-buttons class={`flexCen  boRadXs overHidden bInsetBlueTopXl zinMaXl gapXxxs posAbs marAuto botCen w70 mw90 `}>
					<button
						disabled={zoomLimits.current >= zoomLimits.max}
						onClick={() => {
							zoom.zoomIn();
							mapContainer.current.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
						}}
						className={`grow bHover textAli  padVerXxs mw25  bInsetBlueTopXs2 bBor2  fs8 opacityL xBold ${
							zoomLimits.current >= zoomLimits.max ? 'opacityS noPoint' : ''
						}`}>
						Přiblížit
					</button>
				

				{/* NAVIGATION MESSAGES AND RESET --------------------------- */}
				{!singleEvent &&
					(brain.eventPopup ||
						clusterEventsRef.current.length > 0 ||
						!snap?.types?.some(type => avail?.types?.includes(type)) ||
						(inited.current && snapItems.current?.length !== brain.itemsOnMap?.length)) && (
						<button
							onClick={() => {
								if (brain.eventPopup || clusterEventsRef.current.length > 0) delete brain.eventPopup, (clusterEventsRef.current = []), setRecalc(prev => prev + 1);
								else zoom.fitMap(), mapContainer.current.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
							}}
							className={`${brain.eventPopup || clusterEventsRef.current.length > 0 ? 'bDarkPurple' : 'bDarkRed'} grow boRadXxs textAli mw30 bHover tWhite padVerXxs fs8 xBold`}>
							{`${
								brain.eventPopup || clusterEventsRef.current.length > 0
									? 'zavřít náhled'
									: !snap?.types?.some(type => avail?.types?.includes(type))
									? 'Nemáš zvolené typy událostí !!!'
									: snapItems.current?.length !== brain.itemsOnMap?.length
									? 'Nevidíš všechno'
									: ''
							}`}
						</button>
					)}

					<button
						disabled={zoomLimits.current <= zoomLimits.min}
						onClick={() => {
							zoom.zoomOut();
							mapContainer.current.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
						}}
						className={`grow bHover textAli  padVerXxs mw25  bInsetBlueTopXs2 bBor2  fs8 opacityL xBold ${
							zoomLimits.current <= zoomLimits.min ? 'opacityS noPoint' : ''
						}`}>
						Oddálit
					</button>
				
			</map-buttons>

			<blue-divider class={` hr1 borTop block bInsetBlueTopXl borTop bgTrans posAbs botCen zinMax downTinyBit w100  mw160   marAuto   `} />
		</map-libre>
	);
}

// RENDER OPTIMIZATION -----------------------------------------------------
function dontRender(prev, next) {
	return prev.map === next.map && prev.snap === next.snap && prev.nowAt === next.nowAt && prev.fadedIn === next.fadedIn && prev.show === next.show;
}

export default memo(MapLibre, dontRender);
