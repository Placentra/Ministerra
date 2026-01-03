// TODO consider more than 4 categories at the launch
export const comps = {
	event: ['Image', 'TitleTexts', 'Content', 'Texts', 'BsEvent', 'RatingBs', 'TextArea', 'Entrance', 'Discussion', 'SortMenu'],
	home: ['Header', 'HeaderTexts', 'Quicks', 'CatFilter', 'Tools', 'Content'],
	setup: ['Personals', 'Cities', 'Indis', 'Basics', 'Favex', 'Picture', 'Groups'],
	editor: ['CatFilter', 'Filter', 'IntroTexts', 'Cropper', 'EventInfo'],
};

export const shareSrc = ['Facebook', 'Twitter', 'WhatsApp', 'Instagram', 'Email', 'Pozvat'];
import { FRIENDLY_MEETINGS, BENEFICIAL_EVENTS, CULTURAL_EVENTS, PROFESSIONAL_EVENTS } from '../shared/constants';

export const showObj = { quick: false, tools: 'basic', filter: false, times: false, sorts: false, sherlock: false, history: false, map: false, views: false, view: 'cityEvents' };
export const sherlockObj = { mode: 'standard', gender: null, minAge: 0, maxAge: 0, indis: [], groups: [], basics: [] };
export const emptyBrain = {
	user: {
		history: [],
		alerts: {},
		chats: [],
		comms: [],
		cardsView: { events: 1, users: 1 },
		galleryIDs: { invitesIn: {}, invitesOut: {} },
		chatsList: [],
		linkUsers: [],
		curCities: [],
		invitesIn: {},
		rateInProg: {},
		interInProg: {},
		privInProg: {},
		invitesOut: {},
		pastEve: {},
		eveInters: [],
		cities: [],
		eveUserIDs: {},
		prevLoadedContIDs: {},
		settings: { showAllThumbs: true },
		cols: { topEvents: 1, events: 2, users: 4, pastUsers: 5, eveStrips: 3, userStrips: 5, chatStrips: 1, inviteStrips: 3, locaStrips: 4, alertStrips: 4 },
		search: { events: {}, users: {}, chats: {}, links: {} },
		noMore: { chats: { chats: false, archive: false, inactive: false, hidden: false }, messInChats: [], search: {}, gallery: {}, alerts: false },
	},

	homeView: 'cityEvents',
	meetStats: {},
	citiesTypesInTimes: {},
	citiesContSync: {},
	events: {},
	bestOfIDs: [],
	users: {},
	cities: [],
	chatStoreInProg: {},
	rateInProg: {},
	interInProg: {},
	privInProg: {},
};

export const eventTitles = {
	a1: {
		// Meeting outdoors
		beforeName: ['Čau jsem', 'Ahoj tady', 'Zdravím, jsem', 'Tady', 'Nazdar, jsem', 'Ahoj, tady', 'Čau, tady', 'Zdravím, tady', 'Nazdar, tady', 'Ahoj, jsem'],
		afterName: [
			', půjdeme ven?',
			', dáme procházku?',
			', přidáš se na výlet?',
			', půjdeme na vzduch?',
			', dáme venkovní akci?',
			', vyrazím ven?',
			', přidáš se na procházku?',
			', půjdeme na venkovní akci?',
			', sejdeme se venku?',
			', půjdeme do města?',
		],
		instrumental: [
			'Půjdeš ven',
			'Vyrazíš na procházku',
			'Přidáš se na výlet',
			'Půjdeš na vzduch',
			'Vyrazíš na venkovní akci',
			'Půjdeš ven',
			'Přidáš se na procházku',
			'Půjdeš na venkovní akci',
			'Sejdeš se venku',
			'Půjdeš do města',
		],
	},
	a2: {
		// Meeting in the pub / beer
		beforeName: ['Čau jsem', 'Ahoj tady', 'Honza jde na pivko, přidáš se?', 'Zdravím, jsem', 'Tady', 'Nazdar, jsem', 'Ahoj, tady', 'Čau, tady', 'Zdravím, tady', 'Nazdar, tady'],
		afterName: [
			', zajdem na pivko?',
			', dáme jedno vychlazený?',
			', posedíme v hospě?',
			', zašel bych krýgl, půjdem?',
			', dáme pivko?',
			', půjdeme na pivo?',
			', posedíme v hospodě?',
			', dáme jedno?',
			', půjdeme na jedno?',
			', dáme pivko?',
		],
		instrumental: ['Zajdeš na pivko', 'Dáme chlazený', 'Posedíš v hospě', 'Zašel bys na krýgl', 'Dáme pivko', 'Půjdeš na pivo', 'Posedíš v hospodě', 'Dáme jedno', 'Půjdeš na jedno', 'Dáme pivko'],
	},
	a3: {
		// Meeting on an event
		beforeName: ['Čau jsem', 'Ahoj tady', 'Zdravím, jsem', 'Tady', 'Nazdar, jsem', 'Ahoj, tady', 'Čau, tady', 'Zdravím, tady', 'Nazdar, tady', 'Ahoj, jsem'],
		afterName: [
			', půjdeme na akci?',
			', zajdem spolu na akci?',
			', přidáš se na akci?',
			', půjdeme na událost?',
			', zajdeme na událost?',
			', vyrazíme mezi lidi?',
			', přidáš se na událost?',
			', půjdeme na ňákej event?',
			', dáme akci?',
			', půjdeme na akci?',
		],
		instrumental: [
			'Půjdeš na akci',
			'Zajdeš na akci',
			'Přidáš se na akci',
			'Půjdeš na událost',
			'Zajdeš na událost',
			'Vyrazíš mezi lidi',
			'Přidáš se na událost',
			'Půjdeš na event',
			'Dáš akci',
			'Půjdeš na akci',
		],
	},
	a7: {
		// Discussion meeting
		beforeName: ['Čau jsem', 'Ahoj tady', 'Zdravím, jsem', 'Tady', 'Nazdar, jsem', 'Ahoj, tady', 'Čau, tady', 'Zdravím, tady', 'Nazdar, tady', 'Ahoj, jsem'],
		afterName: [
			', dáme diskuzi?',
			', posedíme a pokecáme?',
			', přidáš se na diskuzi?',
			', půjdeme diskutovat?',
			', dáme diskuzi?',
			', půjdeme na diskuzi?',
			', posedíme a pokecáme?',
			', přidáš se na diskuzi?',
			', půjdeme diskutovat?',
			', dáme diskuzi?',
		],
		instrumental: [
			'Dáš diskuzi',
			'Posedíš a pokecáš',
			'Přidáš se na diskuzi',
			'Půjdeš diskutovat',
			'Dáš diskuzi',
			'Půjdeš na diskuzi',
			'Posedíš a pokecáš',
			'Přidáš se na diskuzi',
			'Půjdeš diskutovat',
			'Dáš diskuzi',
		],
	},
};

export const catsSrc = {
	cz: ['Přátelské', 'Kulturní', 'Odborné', 'Prospěšné'],
	en: ['Meetings', 'Events', 'Courses', 'Goodwill'],
};

export const ratingSrc = {
	event: {
		rating: ['nelíbí', 'dobrý', 'skvělý', 'výtečný!'],
		awards: {
			en: ['Wasteful', 'Superficial', 'Hello', 'Nazdar', 'Educational', 'Beneficial'],
			cz: ['konzumní', 'zbytečné', 'záživné', 'morální', 'naučné', 'Prospěšné'],
		},
		awardsTexts: [
			'Plýtvá, nadměrná spotřebá, konzum, luxus.',
			'Primitivní, nemorální, hloupé, povrchní.',
			'Zábavné, vizuální a nebo interaktivní',
			'Podporuje slušné chování a rozumné myšlení ',
			'Zvyšuje inteligenci, vzdělanost a přehled.',
			'Prospívá procesům, přírodě, zvířatům či lidem',
		],
	},
	meeting: {
		rating: ['slabé', 'dobrý', 'skvělý', 'výtečný!'],
		awards: {
			en: ['dislike', 'sympathetic', 'interesting', 'témata'],
			cz: ['nelíbí', 'sympaťáci', 'zajímavé', 'témata'],
		},
		awardsTexts: [
			'Konzumní či povrchní témata, nevhodné aktivity, nesmyslné, škodlivé či zbytečné prvky',
			'...sympatická, charismatická či inteligentně působící partička lidí, které chceš potkat',
			'Unikátní náplň nebo prospěšné, či obohacující aktivity či jiné nadstandartní prvky',
			'Zajímavá konverzační či expertní témata nebo atraktivní skladba osobnostních indikátorů',
		],
	},
	user: {
		rating: ['dobrý', 'skvělý'],
		awards: {
			en: ['Sympatie', 'Zajímavá', 'Prospěšná', 'Expertní'],
			cz: ['Sympathetic', 'Intriguing', 'Beneficial', 'Expertní'],
		},
		awardsTexts: ['Příjemný vzled, charisma, líbí se mi.', '...témata, zábavná nebo záživná.', '...témata, pro zdravou společnost.', '...témata, užitečná pro hodně lidí.'],
	},
	comment: {
		rating: ['slabé', 'dobré', 'skvělé', 'super'],
		awards: {
			en: ['Bezobsažné', 'Povrchní', 'Zajímavé', 'Inspirativní'],
			cz: ['Bezobsažné', 'Povrchní', 'Zajímavé', 'Inspirativní'],
		},
		awardsTexts: ['Bezobsažné, nezajímavé, neinspirativní.', 'Povrchní, nekvalitní, nekonzistentní.', 'Zajímavé, kvalitní, hodnotné.', 'Inspirativní, motivující, obohacující.'],
	},
};

const allEventTypes = [FRIENDLY_MEETINGS, CULTURAL_EVENTS, PROFESSIONAL_EVENTS, BENEFICIAL_EVENTS];
export const typesMap = new Map([...allEventTypes.flatMap(type => [...type])]);
export const catTypesStructure = catsSrc.cz.reduce(
	(map, value, i) =>
		map.set(value, {
			ids: Array.from(allEventTypes[i].keys()),
			names: Array.from(allEventTypes[i].values()),
		}),
	new Map()
);
