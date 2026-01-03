// IMPORTS AND DEPENDENCIES ---
// Core React hooks and external utilities for event feedback management.
import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import useCentralFlex from '../hooks/useCentralFlex';

// RATING BANDS DATA ---
// Definitions for the primary event satisfaction rating categories.
const ratingBands = [
	{ id: '1-2', scores: [1, 2], title: 'Katastrofa', desc: 'Totální selhání organizace, chaos na všech úrovních, ztráta času a peněz', img: '/covers/0.png', icon: '/icons/types/0.png' },
	{ id: '3-4', scores: [3, 4], title: 'Podprůměr', desc: 'Nesplněná očekávání, zásadní nedostatky v klíčových oblastech, zklamání', img: '/covers/1.png', icon: '/icons/types/1.png' },
	{ id: '5-6', scores: [5, 6], title: 'Průměr', desc: 'Základní standard splněn, bez výrazných pozitiv či negativ, neutrální zážitek', img: '/covers/2.png', icon: '/icons/types/2.png' },
	{ id: '7-8', scores: [7, 8], title: 'Nadprůměr', desc: 'Kvalitní provedení, profesionální přístup, příjemný zážitek k doporučení', img: '/covers/3.png', icon: '/icons/types/3.png' },
	{ id: '9-10', scores: [9, 10], title: 'Excelentní', desc: 'Mimořádný zážitek, překonání všech očekávání, nezapomenutelná událost', img: '/covers/public.jpg', icon: '/icons/types/4.png' },
];

// ASPECT SLIDERS DATA ---
// Granular quality dimensions that users can rate on a numerical scale.
const aspectSliders = [
	{ id: 'sound', label: 'Zvuková a světelná technika', desc: 'Kvalita ozvučení, osvětlení, projekce a AV vybavení' },
	{ id: 'schedule', label: 'Dodržování časového plánu', desc: 'Přesnost začátků, přechodů mezi bloky, celková plynulost' },
	{ id: 'hospitality', label: 'Péče o účastníky a hosty', desc: 'Vstřícnost týmu, ochota pomoci, osobní přístup' },
	{ id: 'hygiene', label: 'Hygienický standard prostor', desc: 'Čistota toalet, společných prostor, zázemí' },
	{ id: 'security', label: 'Bezpečnost a ochrana', desc: 'Pocit bezpečí, řešení incidentů, první pomoc' },
	{ id: 'value', label: 'Hodnota za investovaný čas', desc: 'Poměr přínosu k času a penězům' },
	{ id: 'eco', label: 'Ekologická odpovědnost', desc: 'Třídění odpadu, udržitelné materiály, uhlíková stopa' },
	{ id: 'location', label: 'Lokalita a dopravní dostupnost', desc: 'MHD, parkování, bezbariérovost, orientace' },
	{ id: 'atmosphere', label: 'Celková atmosféra a energie', desc: 'Vibe prostředí, nálada, vizuální dojem' },
	{ id: 'networking', label: 'Příležitosti k networkingu', desc: 'Prostor pro seznamování, facilitovaný matching' },
	{ id: 'content', label: 'Obsahová kvalita programu', desc: 'Úroveň přednášek, workshopů, vystoupení' },
	{ id: 'innovation', label: 'Inovativnost a originalita', desc: 'Nové přístupy, kreativní řešení, unikátnost' },
];

// FEEDBACK AREAS DATA ---
// Categorized collections of specific positive (praises) and negative (reprimands) points.
const feedbackAreas = [
	{
		id: 'program',
		title: 'Program a obsah',
		praises: [
			{ id: 'prog_depth', label: 'Hloubka a propracovanost obsahu', desc: 'Program měl jasnou strukturu, logickou návaznost a skutečnou hodnotu', icon: '/icons/gallery/futuOwn.png' },
			{ id: 'speakers_ready', label: 'Profesionální a připravení řečníci', desc: 'Přednášející ovládali téma, mluvili srozumitelně a poutavě', icon: '/icons/gallery/futuSurMay.png' },
			{ id: 'balance', label: 'Vyvážená skladba programu', desc: 'Ideální mix přednášek, workshopů, networkingu a odpočinku', icon: '/icons/gallery/futuInt.png' },
			{ id: 'interactive', label: 'Vysoká míra interaktivity', desc: 'Publikum bylo aktivně zapojeno, prostor pro dotazy a diskuzi', icon: '/icons/gallery/links.png' },
			{ id: 'inspiring', label: 'Inspirativní a motivující', desc: 'Odnesl jsem si nové myšlenky, podněty a energii do dalších dnů', icon: '/icons/gallery/trusts.png' },
			{ id: 'practical', label: 'Prakticky využitelné poznatky', desc: 'Konkrétní tipy a postupy aplikovatelné ihned v praxi', icon: '/icons/gallery/requests.png' },
			{ id: 'expert', label: 'Expertní úroveň obsahu', desc: 'Špičkoví odborníci, hluboké know-how, profesionální insights', icon: '/icons/gallery/futuOwn.png' },
		],
		reprimands: [
			{ id: 'shallow', label: 'Povrchní a nekonkrétní obsah', desc: 'Program zůstal na povrchu, chyběla hloubka a konkrétní příklady', icon: '/icons/gallery/pastOwn.png' },
			{ id: 'off_topic', label: 'Nesplněná očekávání z popisu', desc: 'Realita neodpovídala slibům v pozvánce a marketingu', icon: '/icons/gallery/pastSurMay.png' },
			{ id: 'speaker_unprepared', label: 'Nepřipravení a nejistí řečníci', desc: 'Čtení ze slidů, zmatené výklady, chybějící červená nit', icon: '/icons/gallery/pastInt.png' },
			{ id: 'overrun', label: 'Přetahování časových bloků', desc: 'Nedodržené časy, zmatený harmonogram, chybějící přestávky', icon: '/icons/gallery/blocks.png' },
			{ id: 'boring', label: 'Nudný a monotónní program', desc: 'Chyběla energie, dynamika, variabilita formátů', icon: '/icons/gallery/invitesIn.png' },
			{ id: 'repetitive', label: 'Opakující se informace', desc: 'Stejné myšlenky dokola, překryv mezi bloky, redundance', icon: '/icons/gallery/invitesOut.png' },
			{ id: 'outdated', label: 'Zastaralé a neaktuální info', desc: 'Staré trendy, překonané přístupy, nevalidní data', icon: '/icons/gallery/pastOwn.png' },
		],
	},
	{
		id: 'operations',
		title: 'Organizace a logistika',
		praises: [
			{ id: 'checkin_fast', label: 'Bleskový a bezproblémový check-in', desc: 'Registrace bez front, jasný proces, rychlé odbavení', icon: '/icons/gallery/futuOwn.png' },
			{ id: 'timeline_kept', label: 'Přesné dodržení harmonogramu', desc: 'Vše začínalo a končilo podle plánu, skvělý time management', icon: '/icons/gallery/futuSurMay.png' },
			{ id: 'signage', label: 'Vynikající navigace a značení', desc: 'Jasné směrovky, přehledné mapy, snadná orientace', icon: '/icons/gallery/futuInt.png' },
			{ id: 'issue_fix', label: 'Okamžité řešení problémů', desc: 'Rychlá reakce na komplikace, profesionální krizový management', icon: '/icons/gallery/links.png' },
			{ id: 'communication', label: 'Proaktivní a jasná komunikace', desc: 'Včasné informace, aktualizace, notifikace změn', icon: '/icons/gallery/trusts.png' },
			{ id: 'flexibility', label: 'Flexibilita a přizpůsobivost', desc: 'Schopnost reagovat na nečekané situace a požadavky', icon: '/icons/gallery/requests.png' },
			{ id: 'smooth_flow', label: 'Plynulý průběh bez zádrhelů', desc: 'Hladké přechody, žádné čekání, logistická dokonalost', icon: '/icons/gallery/futuOwn.png' },
		],
		reprimands: [
			{ id: 'chaos_entry', label: 'Chaotický vstup a registrace', desc: 'Dlouhé fronty, nejasný systém, zmatení organizátoři', icon: '/icons/gallery/pastOwn.png' },
			{ id: 'delays', label: 'Výrazná zpoždění programu', desc: 'Bloky nezačínaly včas, dlouhé prodlevy, ztráta času', icon: '/icons/gallery/pastSurMay.png' },
			{ id: 'missing_info', label: 'Chybějící klíčové informace', desc: 'Nejasný program, nedostupné detaily, zmatené instrukce', icon: '/icons/gallery/pastInt.png' },
			{ id: 'staff_confused', label: 'Dezorientovaný a nevědomý tým', desc: 'Personál nevěděl co dělat, protichůdné informace', icon: '/icons/gallery/blocks.png' },
			{ id: 'overcrowded', label: 'Překročená kapacita prostor', desc: 'Přeplněno, nedostatek míst, dusno a nepohodlí', icon: '/icons/gallery/invitesIn.png' },
			{ id: 'technical_issues', label: 'Časté technické výpadky', desc: 'Nefunkční mikrofony, projekce, Wi-Fi, nabíjení', icon: '/icons/gallery/invitesOut.png' },
			{ id: 'bad_flow', label: 'Neplynulý a trhaný průběh', desc: 'Dlouhé pauzy, čekání bez vysvětlení, nejasné přechody', icon: '/icons/gallery/pastOwn.png' },
		],
	},
	{
		id: 'people',
		title: 'Lidé a atmosféra',
		praises: [
			{ id: 'welcoming', label: 'Vřelé a přátelské přivítání', desc: 'Cítil jsem se vítán od prvního momentu, milý tým', icon: '/icons/gallery/futuOwn.png' },
			{ id: 'networking_great', label: 'Výborné příležitosti k networkingu', desc: 'Snadné navazování kontaktů, facilitované seznamování', icon: '/icons/gallery/futuSurMay.png' },
			{ id: 'inclusive', label: 'Inkluzivní a otevřená atmosféra', desc: 'Každý se mohl zapojit, žádné bariéry, respekt k odlišnostem', icon: '/icons/gallery/futuInt.png' },
			{ id: 'moderation_pro', label: 'Profesionální a poutavá moderace', desc: 'Moderátor držel energii, timing, publikum v pozornosti', icon: '/icons/gallery/links.png' },
			{ id: 'energy_positive', label: 'Pozitivní a nabíjející energie', desc: 'Skvělá atmosféra, nadšení účastníků, dobrá nálada', icon: '/icons/gallery/trusts.png' },
			{ id: 'diversity_people', label: 'Zajímavá a různorodá komunita', desc: 'Pestré složení účastníků, inspirativní lidé, nové perspektivy', icon: '/icons/gallery/requests.png' },
			{ id: 'helpful_attendees', label: 'Ochotní a vstřícní účastníci', desc: 'Lidé si pomáhali, sdíleli tipy, spolupracovali', icon: '/icons/gallery/futuOwn.png' },
		],
		reprimands: [
			{ id: 'rude_staff', label: 'Nepříjemný a arogantní personál', desc: 'Neochotný přístup, povýšenost, nezájem o účastníky', icon: '/icons/gallery/pastOwn.png' },
			{ id: 'cliques', label: 'Uzavřené a nepřístupné skupiny', desc: 'Těžké se zapojit, etablované kliky, vyloučení nováčků', icon: '/icons/gallery/pastSurMay.png' },
			{ id: 'crowd_negative', label: 'Nepříjemní a rušiví účastníci', desc: 'Agresivní chování, hluk, nerespektování ostatních', icon: '/icons/gallery/pastInt.png' },
			{ id: 'conflicts_ignored', label: 'Ignorované konflikty a problémy', desc: 'Chyběl zásah organizátorů při problémech', icon: '/icons/gallery/blocks.png' },
			{ id: 'discrimination', label: 'Diskriminační nebo necitlivé chování', desc: 'Nevhodné poznámky, vyloučení, nerespekt', icon: '/icons/gallery/invitesIn.png' },
			{ id: 'cold_atmosphere', label: 'Chladná a nepřátelská atmosféra', desc: 'Sterilní prostředí, distance, žádná komunita', icon: '/icons/gallery/invitesOut.png' },
			{ id: 'no_networking', label: 'Žádné příležitosti k networkingu', desc: 'Chyběl prostor a čas na seznamování', icon: '/icons/gallery/pastOwn.png' },
		],
	},
	{
		id: 'comfort',
		title: 'Zázemí a služby',
		praises: [
			{ id: 'venue_clean', label: 'Perfektně čisté a upravené prostory', desc: 'Toalety, sály, zázemí - vše v bezvadném stavu', icon: '/icons/gallery/futuOwn.png' },
			{ id: 'catering_great', label: 'Výborný a rozmanitý catering', desc: 'Kvalitní jídlo a pití, dostatek pro všechny, dietary options', icon: '/icons/gallery/futuSurMay.png' },
			{ id: 'tech_works', label: 'Bezchybně fungující technika', desc: 'Vše fungovalo jak má, žádné výpadky, profesionální AV', icon: '/icons/gallery/futuInt.png' },
			{ id: 'access_easy', label: 'Snadná dostupnost pro všechny', desc: 'Bezbariérovost, dobré spojení MHD, parkování', icon: '/icons/gallery/links.png' },
			{ id: 'seating_comfy', label: 'Pohodlné sezení a prostor', desc: 'Kvalitní židle, dostatek místa, ergonomie', icon: '/icons/gallery/trusts.png' },
			{ id: 'climate_perfect', label: 'Příjemná teplota a ventilace', desc: 'Ideální klima, čerstvý vzduch, bez extrémů', icon: '/icons/gallery/requests.png' },
			{ id: 'wifi_fast', label: 'Rychlá a spolehlivá Wi-Fi', desc: 'Stabilní připojení, dostatečná kapacita, snadné přihlášení', icon: '/icons/gallery/futuOwn.png' },
		],
		reprimands: [
			{ id: 'dirty', label: 'Špinavé a zanedbané prostory', desc: 'Nečisté toalety, odpadky, nepořádek', icon: '/icons/gallery/pastOwn.png' },
			{ id: 'catering_poor', label: 'Nedostatečné nebo nekvalitní občerstvení', desc: 'Málo jídla, špatná kvalita, žádné alternativy', icon: '/icons/gallery/pastSurMay.png' },
			{ id: 'tech_fail', label: 'Opakované selhání techniky', desc: 'Mikrofony, projekce, zvuk - stálé problémy', icon: '/icons/gallery/pastInt.png' },
			{ id: 'hard_access', label: 'Špatná dostupnost a parkování', desc: 'Daleko od MHD, drahé/žádné parkování, bariéry', icon: '/icons/gallery/blocks.png' },
			{ id: 'uncomfortable', label: 'Nepohodlné sezení a prostory', desc: 'Špatné židle, málo místa, stísněnost', icon: '/icons/gallery/invitesIn.png' },
			{ id: 'bad_climate', label: 'Nevhodná teplota a špatný vzduch', desc: 'Příliš horko/zima, dusno, zápach', icon: '/icons/gallery/invitesOut.png' },
			{ id: 'no_wifi', label: 'Nefunkční nebo pomalá Wi-Fi', desc: 'Nelze se připojit, výpadky, přetížení', icon: '/icons/gallery/pastOwn.png' },
		],
	},
	{
		id: 'impact',
		title: 'Hodnota a celkový dojem',
		praises: [
			{ id: 'value_excellent', label: 'Vynikající hodnota za investici', desc: 'Stálo to za každou korunu a minutu času', icon: '/icons/gallery/futuOwn.png' },
			{ id: 'takeaways_clear', label: 'Jasné a konkrétní výstupy', desc: 'Odnesl jsem si akční kroky, materiály, kontakty', icon: '/icons/gallery/futuSurMay.png' },
			{ id: 'eco_conscious', label: 'Ekologicky odpovědný přístup', desc: 'Minimální odpad, udržitelné materiály, ohleduplnost', icon: '/icons/gallery/futuInt.png' },
			{ id: 'sponsors_relevant', label: 'Relevantní a nenásilní partneři', desc: 'Partneři ladili s tématem, bez agresivního sales', icon: '/icons/gallery/links.png' },
			{ id: 'memorable', label: 'Nezapomenutelný a transformativní zážitek', desc: 'Změnilo to můj pohled, zážitek na celý život', icon: '/icons/gallery/trusts.png' },
			{ id: 'recommend_strong', label: 'Jednoznačně doporučuji ostatním', desc: 'Budu aktivně šířit pozitivní reference', icon: '/icons/gallery/requests.png' },
			{ id: 'exceeded', label: 'Překonalo všechna očekávání', desc: 'Lepší než jsem čekal, příjemné překvapení', icon: '/icons/gallery/futuOwn.png' },
		],
		reprimands: [
			{ id: 'overpriced', label: 'Výrazně předražené vstupné', desc: 'Cena neodpovídala kvalitě a rozsahu', icon: '/icons/gallery/pastOwn.png' },
			{ id: 'salesy', label: 'Příliš komerční a reklamní', desc: 'Reklama místo obsahu, sales pitche, manipulace', icon: '/icons/gallery/pastSurMay.png' },
			{ id: 'wasteful', label: 'Zbytečné plýtvání zdroji', desc: 'Nevyužité materiály, jídlo v koši, ekologická katastrofa', icon: '/icons/gallery/pastInt.png' },
			{ id: 'sponsors_bad', label: 'Nevhodní a rušiví partneři', desc: 'Nesouvisející značky, agresivní promo, odpuzující', icon: '/icons/gallery/blocks.png' },
			{ id: 'forgettable', label: 'Snadno zapomenutelné a nijaké', desc: 'Nic zvláštního, bez wow efektu, průměr', icon: '/icons/gallery/invitesIn.png' },
			{ id: 'not_recommend', label: 'Rozhodně nedoporučuji', desc: 'Budu varovat ostatní, negativní reference', icon: '/icons/gallery/invitesOut.png' },
			{ id: 'disappointed', label: 'Hluboké zklamání z akce', desc: 'Očekával jsem víc, nesplněné sliby', icon: '/icons/gallery/pastOwn.png' },
		],
	},
];

// STATE DEFAULTS AND EVALUATION PARAMETERS ---
// Initial state for evaluation data and intensity levels for categorical feedback.
const defaultDraft = { rating: null, praises: {}, reprimands: {}, comment: '', ideas: '', aspects: {}, payload: {} };
const MAX_LEVEL = 3;

// VISUAL STYLE CONFIGURATIONS ---
// Color palettes and utility functions for feedback intensity indicators.
const gaugeColors = ['rgb(161, 0, 0)', '#f4511e', '#fb8c00', '#fdd835', 'rgb(173, 205, 84)', 'rgb(113, 207, 99)', '#43a047', '#00897b', 'rgb(159, 107, 198)', 'rgb(193, 0, 100)'];

// RGBA CONVERTER ---
// Normalizes hex and rgb color strings to rgba with specified alpha transparency.
const toRgba = (color, alpha = 1) => {
	if (!color) return `rgba(0,0,0,${alpha})`;
	if (color.startsWith('#')) {
		const hex = color.slice(1);
		const bigint = parseInt(hex.length === 3 ? hex.replace(/./g, m => m + m) : hex, 16);
		const r = (bigint >> 16) & 255,
			g = (bigint >> 8) & 255,
			b = bigint & 255;
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	}
	if (color.startsWith('rgb')) {
		const nums = color
			.replace(/[^\d,]/g, '')
			.split(',')
			.map(n => Number(n.trim()));
		const [r = 0, g = 0, b = 0] = nums;
		return `rgba(${r}, ${g}, ${b}, ${alpha})`;
	}
	return `rgba(0,0,0,${alpha})`;
};

// GAUGE INDICATOR COMPONENT ---
// Renders a segmented rating scale (1-10) for quantitative aspect evaluation.
const Gauge = ({ value = 0, onSelect }) => (
	<gauge-row className='flexRow w100 boRadXxs overHid shaCon'>
		{Array.from({ length: 10 }).map((_, idx) => {
			const active = value >= idx + 1,
				bg = gaugeColors[idx];
			return (
				<gauge-square
					key={idx}
					className='grow shaCon flex1 flexCen'
					onClick={() => onSelect(idx + 1)}
					onMouseEnter={e => (e.currentTarget.style.opacity = '0.7')}
					onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
					style={{ background: active ? bg : 'rgba(120,140,160,0.15)', borderRight: idx < 9 ? '1px solid rgba(255,255,255,0.4)' : 'none', padding: '5px 0', minHeight: '1.5rem' }}>
					<span className={`fs7 boldXs  block aliCen w100 ${active ? 'tWhite textSha' : 'tDarkGrey'}`}>{idx + 1}</span>
				</gauge-square>
			);
		})}
	</gauge-row>
);

// MAIN PROTOCOL COMPONENT ---
// Manages the entire feedback submission workflow, including local state and server sync.
function EventFeedbackProtocol({ obj, brain, onClose, isOwner, mode = 'inline' }) {
	const [draft, setDraft] = useState(defaultDraft),
		[totals, setTotals] = useState(null),
		[saving, setSaving] = useState(false),
		[inform, setInform] = useState([]);

	// COMPUTED PROPERTIES ---
	// Derived values for validation and layout optimization.
	const canSubmit = obj?.id && brain?.user?.id,
		isFriendly = obj?.type.startsWith('a');
	const allPraisesCount = feedbackAreas.flatMap(a => a.praises).length,
		allReprimandsCount = feedbackAreas.flatMap(a => a.reprimands).length;
	const praiseWidth = useCentralFlex('feedbackPraises', [Object.keys(draft.praises).length], null, allPraisesCount);
	const reprimandWidth = useCentralFlex('feedbackReprimands', [Object.keys(draft.reprimands).length], null, allReprimandsCount);
	const aspectWidth = useCentralFlex('feedbackAspects', [draft.aspects], null, aspectSliders.length);

	// LOAD PREVIOUS FEEDBACK ---
	// Retrieves existing user feedback and aggregate event totals on mount.
	useEffect(() => {
		if (!obj?.id) return;
		(async () => {
			try {
				const { data } = await axios.post('feedback', { mode: 'getMine', eventID: obj.id, userID: brain?.user?.id });
				const fb = data?.feedback || {};
				// LEGACY DATA NORMALIZATION ---
				// Converts old array format to level-based intensity objects.
				const normalizeLevels = val => (Array.isArray(val) ? val.reduce((acc, id) => ((acc[id] = 1), acc), {}) : val || {});
				setDraft(prev => ({
					...prev,
					...defaultDraft,
					...fb,
					praises: normalizeLevels(fb.praises),
					reprimands: normalizeLevels(fb.reprimands),
					aspects: fb.aspects || {},
					payload: fb.payload || {},
				}));
				if (data?.totals) setTotals(data.totals);
			} catch {
				setInform(prev => [...prev.filter(i => i !== 'loadFail'), 'loadFail']);
			}
		})();
	}, [obj?.id, brain?.user?.id]);

	// FEEDBACK MANAGERS ---
	// Functions to update local evaluation state and intensity levels.

	// CYCLE CATEGORY LEVEL ---
	// Toggles between intensity levels 1, 2, 3 and deselection (0).
	const cycleItem = (type, id) =>
		setDraft(prev => {
			const currentLevel = prev[type][id] || 0,
				newLevel = currentLevel >= MAX_LEVEL ? 0 : currentLevel + 1;
			const copy = { ...prev[type] };
			if (newLevel === 0) delete copy[id];
			else copy[id] = newLevel;
			return { ...prev, [type]: copy };
		});

	// REMOVE SINGLE ITEM ---
	// Explicitly deletes a categorical feedback point from the draft.
	const deselectItem = (type, id) =>
		setDraft(prev => {
			const copy = { ...prev[type] };
			delete copy[id];
			return { ...prev, [type]: copy };
		});

	// RESET BATCH ---
	// Clears all praises or reprimands in the current draft.
	const clearItems = scope =>
		setDraft(prev => ({ ...prev, praises: scope === 'all' || scope === 'praises' ? {} : prev.praises, reprimands: scope === 'all' || scope === 'reprimands' ? {} : prev.reprimands }));

	// UPDATE ASPECT SCALE ---
	// Sets the numerical value for a specific quality dimension slider.
	const setAspect = (id, val) => setDraft(prev => ({ ...prev, aspects: { ...prev.aspects, [id]: Number(val) } }));

	// PERSISTENCE HANDLER ---
	// Submits the finalized evaluation data to the backend API.
	const submit = async () => {
		if (!canSubmit) return;
		const issues = [];
		if (!draft.rating) issues.push('missingRating');
		setInform(issues);
		if (issues.length) return;
		setSaving(true);
		try {
			const payload = { ...draft, payload: { rating: draft.rating, praises: draft.praises, reprimands: draft.reprimands, aspects: draft.aspects, comment: draft.comment, ideas: draft.ideas } };
			const { data } = await axios.post('feedback', { mode: 'submit', eventID: obj.id, userID: brain.user.id, payload });
			if (data?.totals) setTotals(data.totals);
			setInform(['saved']);
		} catch {
			setInform(['saveFail']);
		} finally {
			setSaving(false);
		}
	};

	// AGGREGATE COMPUTATIONS ---
	// Memoized average calculation for the event owner summary.
	const avgRating = useMemo(() => (!totals || !totals.rating_count ? null : (totals.rating_sum / totals.rating_count).toFixed(1)), [totals]);
	if (isFriendly) return null;

	// FLATTENED DATA SOURCES ---
	// Consolidated arrays for quick mapping and lookup across areas.
	const allPraises = feedbackAreas.flatMap(a => a.praises),
		allReprimands = feedbackAreas.flatMap(a => a.reprimands);

	// COMPONENT VIEW RENDERING ---
	// JSX structure for the feedback protocol interface.
	return (
		<feedback-protocol
			className={mode === 'modal' ? 'posAbs center flexCol aliCen  zinMaxl scrolling' : 'posRel   shaStrong padAllXs bgTrans w100 marBotXl   '}
			onClick={e => mode === 'modal' && e.stopPropagation()}>
			{mode === 'modal' && <feedback-overlay className='bgShadow posAbs center' onClick={() => onClose?.()} />}

			<protocol-card class=' shaStrong posRel w100 flexCol bInsetBlueTop borTopLight'>
				{/* RATING STRIP --------------------------- */}
				<rating-bands class='flexCen aliStretch shaBlueLight bInsetBlueTop borTopLight posRel justCen w100'>
					{ratingBands.map((band, bandIdx) => {
						const inBand = band.scores.includes(draft.rating);
						const handleBandClick = () =>
							setDraft(prev => {
								if (!prev.rating || !band.scores.includes(prev.rating)) return { ...prev, rating: band.scores[0] };
								return { ...prev, rating: prev.rating === band.scores[0] ? band.scores[1] : band.scores[0] };
							});
						return (
							<rating-band key={band.id} className={`flexCol shaBlueLight aliStretch posRel grow pointer hvh30 padTopXl ${inBand ? 'shaBlue' : ''}`} onClick={handleBandClick}>
								<img className='posAbs topCen h70 w100 cover maskLow' src={band.img} alt='' />
								<rating-content class='posRel flexCol aliCen zinMax'>
									<img className='mw18 aspect1610 w60 bgTrans padHorXxxs shaTop marBotXxxs' src={band.icon} alt='' />
									<span className='fs8 boldS textSha marVerXs'>{band.title}</span>
									<span className='fs7 textSha aliCen inlineBlock lh1-2'>{band.desc}</span>
									<rating-buttons class='flexCen h100 aliStretch marTopAuto  gapXxxs w100'>
										{band.scores.map((score, idx) => (
											<feedback-button
												key={score}
												style={{ background: draft.rating === score ? gaugeColors[bandIdx * 2 + idx] : 'transparent', color: draft.rating === score ? '#fff' : '#666' }}
												className={`padHorS grow boRadXs   ${draft.rating === score ? 'tSha10' : 'tLightBlue'} padVerXs marTopS fs10 bold posRel pointer bHover`}
												onClick={e => {
													e.stopPropagation();
													setDraft(prev => ({ ...prev, rating: score }));
												}}>
												{score}
											</feedback-button>
										))}
									</rating-buttons>
								</rating-content>
							</rating-band>
						);
					})}
				</rating-bands>

				{/* FEEDBACK AREAS - SECTIONED --------------------------- */}
				{feedbackAreas.map(area => (
					<feedback-area key={area.id} class='flexCol w100 marBotXl bInsetBlueTopXs borTopLight'>
						<span className='fs17 xBold textSha marTopXxl inlineBlock marBotS aliCen'>{area.title}</span>

						{/* PRAISES FOR THIS AREA */}
						<praises-section class='flexCol w100 '>
							{/* <span className='fs11 boldM tGreen textSha marBotXs inlineBlock'>Co se povedlo</span> */}
							<praises-grid className='flexCen wrap w100 aliStretch'>
								{area.praises.map(item => {
									const level = draft.praises[item.id] || 0;
									const palette = [gaugeColors[7], gaugeColors[8], gaugeColors[9]];
									const col = palette[level - 1],
										o = { 1: 0.18, 2: 0.42, 3: 0.38 }[level],
										s = { 1: '16%', 2: '14%', 3: '16%' }[level];
									const makeGrad = dir => `linear-gradient(to ${dir}, ${toRgba(col, o)} 0%, ${toRgba(col, o * 0.4)} ${parseInt(s) / 2}%, transparent ${s})`;
									const bgGradient = level === 0 ? '' : `${makeGrad('right')}, ${makeGrad('left')}, ${makeGrad('bottom')}, ${makeGrad('top')}`;
									return (
										<feedback-button
											key={item.id}
											style={{ width: praiseWidth ? `${praiseWidth}px` : 'auto', background: bgGradient, transition: 'background 0.25s ease' }}
											className='shaBlueLight boRadXxs padHorXs padVerXs bHover flexCol aliCen posRel'
											onClick={() => cycleItem('praises', item.id)}>
											<img className='mw6 w50 miw3 marBotXxs' src={item.icon} alt='' />
											<span className='fs8 marBotXxxs boldS aliCen textSha w80 lh1-1'>{item.label}</span>
											<span className='fs7 tDarkGrey aliCen lh1'>{item.desc}</span>
										</feedback-button>
									);
								})}
							</praises-grid>
						</praises-section>

						{/* REPRIMANDS FOR THIS AREA */}
						<reprimands-section class='flexCol w100'>
							{/* <span className='fs11 boldM tRed textSha marBotXs inlineBlock'>Co nefungovalo</span> */}
							<reprimands-grid class='flexCen wrap w100 aliStretch'>
								{area.reprimands.map(item => {
									const level = draft.reprimands[item.id] || 0;
									const palette = [gaugeColors[2], gaugeColors[1], gaugeColors[0]];
									const col = palette[level - 1],
										o = { 1: 0.25, 2: 0.39, 3: 0.42 }[level],
										s = { 1: '16%', 2: '14%', 3: '16%' }[level];
									const makeGrad = dir => `linear-gradient(to ${dir}, ${toRgba(col, o)} 0%, ${toRgba(col, o * 0.4)} ${parseInt(s) / 2}%, transparent ${s})`;
									const bgGradient = level === 0 ? '' : `${makeGrad('right')}, ${makeGrad('left')}, ${makeGrad('bottom')}, ${makeGrad('top')}`;
									return (
										<feedback-button
											key={item.id}
											style={{
												width: reprimandWidth ? `${reprimandWidth}px` : 'auto',
												backgroundColor: '#fff',
												backgroundImage: bgGradient,
												transition: 'background 0.25s ease',
											}}
											className='padHorXs padVerS bHover flexCol aliCen posRel'
											onClick={() => cycleItem('reprimands', item.id)}>
											<img className='mw6 w50 miw3 marBotXxs' src={item.icon} alt='' />
											<span className='fs7 bold aliCen marBotXxxs textSha w80 lh1-1'>{item.label}</span>
											<span className='fs6 tDarkGrey aliCen lh1'>{item.desc}</span>
										</feedback-button>
									);
								})}
							</reprimands-grid>
						</reprimands-section>
					</feedback-area>
				))}

				{/* CLEAR BUTTONS */}
				<clear-buttons class='flexRow justCen gapS w100 marBotXl'>
					<feedback-button className='shaCon flexRow mw30 sideBors aliCen justCen padVerXs boRadXs pointer bHover padHorS fs8 xBold tRed' onClick={() => clearItems('praises')}>
						<span className='fs10 xBold tRed textSha marRigXs'>X</span>
						<span className='fs7 textSha'>smazat pochvaly</span>
					</feedback-button>
					<feedback-button className='shaCon flexRow mw30 sideBors aliCen justCen padVerXs boRadXs pointer bHover padHorS fs8 xBold tRed' onClick={() => clearItems('reprimands')}>
						<span className='fs10 xBold tRed textSha marRigXs'>X</span>
						<span className='fs7 textSha'>smazat výtky</span>
					</feedback-button>
				</clear-buttons>

				{/* ASPECTS STRIP --------------------------- */}
				<aspects-strip class='flexCol w100 '>
					<span className='fs12 xBold marBotXs'>Dílčí hodnocení (1-10)</span>
					<aspects-grid class='flexRow wrap w100 aliStretch'>
						{aspectSliders.map(item => (
							<aspect-card key={item.id} style={{ width: aspectWidth ? `${aspectWidth}px` : 'auto' }} class='flexCol marBotS fPadHorXs padVerXs'>
								<span className='fs11 boldM aliCen marBotXs'>{item.label}</span>
								<Gauge value={draft.aspects[item.id] || 0} onSelect={val => setAspect(item.id, val)} />
							</aspect-card>
						))}
					</aspects-grid>
				</aspects-strip>

				{/* TEXT FIELDS STRIP --------------------------- */}
				<textfields-strip class='flexRow wrap justCen gapS w100 marBotS posRel  marAuto bInsetBlueTopXs  padTopXxl'>
					<feedback-field class='flexCol w45 miw36 '>
						<span className='fs10  xBold marBotXs inlineBlock aliCen textSha'>Volný komentář</span>
						<textarea
							value={draft.comment}
							onChange={e => setDraft(prev => ({ ...prev, comment: e.target.value }))}
							className='w100 padAllS textAli fs11 boRadXs shaCon'
							style={{ border: '2px solid #dde', minHeight: '100px', resize: 'vertical' }}
							maxLength={800}
							placeholder='Cokoliv dalšího k akci...'
						/>
					</feedback-field>
					<feedback-field class='flexCol w45 miw36'>
						<span className='fs10  xBold marBotXs inlineBlock aliCen textSha'>Návrhy na zlepšení</span>
						<textarea
							value={draft.ideas}
							onChange={e => setDraft(prev => ({ ...prev, ideas: e.target.value }))}
							className='w100 padAllS textAli fs11 boRadXs shaCon'
							style={{ border: '2px solid #dde', minHeight: '100px', resize: 'vertical' }}
							maxLength={800}
							placeholder='Co by příště mohlo být jinak...'
						/>
					</feedback-field>
				</textfields-strip>

				{/* FOOTER STRIP --------------------------- */}
				<footer-strip class='flexCol aliCen gapS w100 marBotM '>
					{inform.includes('missingRating') && <span className='tRed fs9 boldM textSha'>Vyber prosím celkové hodnocení.</span>}
					{inform.includes('saveFail') && <span className='tRed fs9 boldM textSha'>Uložení se nezdařilo.</span>}
					{inform.includes('saved') && <span className='tGreen fs9 boldM textSha'>Zpětná vazba úspěšně uložena.</span>}
					<feedback-button disabled={!canSubmit || saving} class='bDarkGreen tWhite padHorXxl w100 mw80 padVerS fs10 xBold pointer boRadXs shaStrong bHover' onClick={submit}>
						{saving ? 'Ukládám...' : 'Odeslat zpětnou vazbu'}
					</feedback-button>
					{totals && (
						<span className='fs8 tGrey textSha'>
							Průměr: {avgRating || '-'} • Celkem hodnocení: {totals.rating_count || 0}
						</span>
					)}
				</footer-strip>

				{/* OWNER SUMMARY STRIP --------------------------- */}
				{isOwner && totals && (
					<owner-strip className='flexCol w100 padAllS marTopS' style={{ background: '#f8f8f8' }}>
						<span className='fs12 xBold marBotS'>Souhrn pro pořadatele</span>
						<owner-stats className='flexRow wrap gapS marBotS'>
							<span className='padAllXs bGlassSubtle fs9 bold'>Průměrné hodnocení: {avgRating || '-'}</span>
							<span className='padAllXs bGlassSubtle fs9 bold'>Celkem odpovědí: {totals.rating_count || 0}</span>
						</owner-stats>
						<owner-praises className='flexCol marBotS'>
							<span className='fs7 boldM tGreen marBotXxxs'>Pochvaly</span>
							<owner-row className='flexRow wrap'>
								{allPraises.map(item => (
									<span key={item.id} className='padHorXs padVerXxxs bGlassSubtle fs7 boldM'>
										{item.label}: {totals.praises?.[item.id] || 0}
									</span>
								))}
							</owner-row>
						</owner-praises>
						<owner-reprimands className='flexCol marBotS'>
							<span className='fs7 boldM tRed marBotXxxs'>Výtky</span>
							<owner-row className='flexRow wrap'>
								{allReprimands.map(item => (
									<span key={item.id} className='padHorXs padVerXxxs bGlassSubtle fs7 boldM'>
										{item.label}: {totals.reprimands?.[item.id] || 0}
									</span>
								))}
							</owner-row>
						</owner-reprimands>
						<owner-aspects className='flexCol'>
							<span className='fs7 boldM marBotXxxs'>Dílčí hodnocení</span>
							<owner-row className='flexRow wrap'>
								{aspectSliders.map(item => {
									const data = totals.aspects?.[item.id],
										avg = data?.count ? (data.sum / data.count).toFixed(1) : '-';
									return (
										<span key={item.id} className='padHorXs padVerXxxs bGlassSubtle fs7 boldM'>
											{item.label}: {avg} ({data?.count || 0})
										</span>
									);
								})}
							</owner-row>
						</owner-aspects>
					</owner-strip>
				)}
			</protocol-card>
		</feedback-protocol>
	);
}

export default EventFeedbackProtocol;
