import { capitalize } from './utilities.ts';

export const INTERESTS = { interested: 'int', surely: 'sur', maybe: 'may' } as const;
export const PRIVACIES = { public: 'pub', links: 'lin', owner: 'own', trusts: 'tru', invites: 'inv' } as const;
export const PRIVACIES_SET = new Set(Object.values(PRIVACIES));

export const META_INDEXES_SOURCE = {
	event: { priv: 0, owner: 1, cityID: 2, type: 3, starts: 4, geohash: 5, surely: 6, maybe: 7, comments: 8, score: 9, basiVers: 10, detaVers: 11 },
	user: { priv: 0, age: 1, gender: 2, indis: 3, basics: 4, groups: 5, score: 6, imgVers: 7, basiVers: 8, attend: 9 },
} as const;
export const EVENT_META_INDEXES = Object.fromEntries(Object.entries(META_INDEXES_SOURCE.event).map(([key, value]) => [`eve${capitalize(key)}Idx`, value]));
export const USER_META_INDEXES = Object.fromEntries(Object.entries(META_INDEXES_SOURCE.user).map(([key, value]) => [`user${capitalize(key)}Idx`, value]));

const GENDER = { male: 'm', female: 'f', other: 'o' } as const;
export const GENDER_VALUES = Object.values(GENDER);

const REDIS_KEY_NAMES = [
	'links',
	'blocks',
	'trusts',
	'invites',
	'userSummary',
	'userBasics',
	'userMetas',
	'userSetsLastChange',
	'userNameImage',
	'userChatRoles',
	'userActiveChats',
	'eveMetas',
	'eveBasics',
	'eveDetails',
	'eveCityIDs',
	'eveTitleOwner',
	'friendlyEveScoredUserIDs',
	'remEve',
	'remUse',
	'eveLastAttendChangeAt',
	'lastNewCommAt',
	'chatMembers',
	'chatLeftUsers',
	'lastMembChangeAt',
	'lastSeenChangeAt',
	'citiesData',
	'cityIDs',
	'cityFiltering',
	'cityMetas',
	'cityPubMetas',
	'refreshTokens',
	'verifyCode',
	'dailyLinkReqCounts',
	'dailyIpRegisterCounts',
	'chatMessages',
	'eveComments',
	'eveLastCommentAt',
	'onlineUsers',
	'topEvents',
	'tempProfile',
	'newEveCommsCounts',
	'pastEveCachedAt',
	'commentAuthorContent',
	'serverStarted',
	'lastCommID',
	'lastMessID',
	'last100BestEventsRecalc',
	'tasksFinishedAt',
] as const;

type RedisKey = (typeof REDIS_KEY_NAMES)[number];
export const REDIS_KEYS = REDIS_KEY_NAMES.reduce((acc, key) => {
	acc[key] = key;
	return acc;
}, {} as Record<RedisKey, string>);

export const RETRIABLE_SQL_ERRORS = [
	'ER_LOCK_WAIT_TIMEOUT',
	'ER_LOCK_DEADLOCK',
	'ER_QUERY_TIMEOUT',
	'ER_CON_COUNT_ERROR',
	'ER_TOO_MANY_USER_CONNECTIONS',
	'ER_NET_READ_ERROR',
	'ER_NET_WRITE_ERROR',
	'ER_SERVER_SHUTDOWN',
];

export const USER_INDICATORS = new Map(
	Object.entries({
		1: { label: 'Pohodář', longDesc: 'Jsi extrémně přátelský, nekonfliktní, tolerantní, rád poznáváš lidi a chceš aby tě oslovovali.', shortDesc: 'Přátelský a tolerantní' },
		2: { label: 'Znalec', longDesc: 'Máš obrovské know-how o všem možném a rád ostatní obohacuješ svými znalostmi', shortDesc: 'Znalý a obohacující' },
		3: { label: 'Nezadaný', longDesc: 'Hledáš primárně vztah. Nemáš zájem o sex, chceš se poznat s potenciální partnery.', shortDesc: 'Hledá vztah, ne sex' },
		4: { label: 'Intelektuál', longDesc: 'Nebaví tě chit-chat. Chceš řešít VÝLUEČNĚ náročná a progresivní témata, která mají hloubku.', shortDesc: 'Náročný a přemýšlivý' },
		5: { label: 'Kritik', longDesc: 'Jsi realista. Nespokojený. Umíš objektivně zhodnotit proč je něco špatně. Rád kritizuješ a hledáš chyby.', shortDesc: 'Realista a kritický' },
		6: { label: 'Bavič', longDesc: 'Máš dar k tomu rozesmívat lidi a skutečně to umíš. Tuhle vlastnost pořád trénuješ.', shortDesc: 'Rozesmívá a trénuje' },
		7: { label: 'Divočák', longDesc: 'Možná hledáš vztah, ale možné taky ne. Když se ovšem najde někdo na ... tak ...', shortDesc: 'Svolný k intimnostem.' },
		8: { label: 'Přírodář', longDesc: 'Žiješ v souladu s přírodou. Jsi minimalista. Alternativní člověk, případně duchovně založený.', shortDesc: 'Minimalista či přírodář' },
		9: { label: 'Speaker', longDesc: 'Your english is good enough for fluent and sophisticated disscusion.', shortDesc: 'Fluentní angličtinář' },
		10: { label: 'Podivín', longDesc: 'Jsi jak z jiného světa a nebo máš problém navazovat kontakty. Lidé ti nerozumí, nemáš moc přátel.', shortDesc: 'Nepochopený, zvláštní, možná osamělý' },
	}).map(([key, value]) => [parseInt(key), value])
);

export const BASIC_TOPICS = new Map(
	Object.entries({
		1: 'Vnitrostátní politika',
		2: 'Správná výchova dětí',
		3: 'Rozvoj České republiky',
		4: 'Respektuhodní lidé',
		5: 'Technologie a vynálezy',
		6: 'Ochrana planety',
		7: 'Kritika společnosti',
		8: 'Osobnostní růst',
		9: 'Prospěšné projekty ',
		10: 'Toxický mainstream',
		11: 'Zdravý životní styl',
		12: 'Mezilidské vztahy',
		13: 'Partnerské vztahy',
		14: 'Vzdálená budoucnost',
		15: 'Umělá inteligence',
		16: 'Migrace a mix kultur',
		17: 'Konzum a nadprodukce',
		18: 'Povrchní společnost,',
		19: 'Vzdělávání a věda',
		20: 'Rozvoj tvého města',
		21: 'Dění v Evropské unii',
		22: 'Náboženství a víra',
		23: 'Dopad sociálních sítí',
		24: 'Mentální (ne)zdraví',
		25: 'Budoucnost lidstva',
		26: 'Management a leadership',
		27: 'Život na low-budget',
		28: 'Investice a finance',
	}).map(([key, value]) => [parseInt(key), value.trim()])
);

export const USER_GROUPS = new Map(
	Object.entries({
		Expertise: new Map(
			Object.entries({
				a1: 'marketer',
				a2: 'elektrikář',
				a3: 'stavebník',
				a4: 'řidič',
				a5: 'ředitel',
				a6: 'truhlář',

				a7: 'psycholog',
				a8: 'designer',
				a9: 'programátor',
				a10: 'učitel',
				a11: 'kuchař',
				a12: 'zdravotník',
				a13: 'zahradník',
				a14: 'fotograf',
				a15: 'právník',
				a16: 'lékař',
				a17: 'farmář',
				a18: 'grafik',
				a19: 'architekt',
				a20: 'inženýr',
			})
		),
		Hobbies: new Map(
			Object.entries({
				b1: 'sport',
				b2: 'hudba',
				b3: 'cestování',
				b4: 'pejsci',
				b5: 'vaření',
				b6: 'kočky',
				b7: 'četba',
				b8: 'filmy',
				b9: 'malování',
				b10: 'keramika',
				b11: 'cyklistika',
				b12: 'plavání',
				b13: 'tanec',
				b14: 'divadlo',
				b15: 'yoga',
				b16: 'fotografování',
				b17: 'zahradničení',
				b18: 'pěší turistika',
				b19: 'počítačové hry',
				b20: 'kempování',
			})
		),
		Persona: new Map(
			Object.entries({
				c1: 'pohodový',
				c2: 'nervózní',
				c3: 'přísný',
				c4: 'cynický',
				c5: 'negativní',
				c6: 'veselý',
				c7: 'optimistický',
				c8: 'introvertní',
				c9: 'extravertní',
				c10: 'kreativní',
				c11: 'pracovitý',
				c12: 'vstřícný',
				c13: 'empatický',
				c14: 'ambiciózní',
				c15: 'přátelský',
				c16: 'upovídaný',
				c17: 'tichý',
				c18: 'konkurenční',
				c19: 'nespolehlivý',
				c20: 'zvídavý',
			})
		),
		Special: new Map(
			Object.entries({
				d1: 'zdravotní',
				d2: 'životní',
				d3: 'investor',
				d4: 'nezaměstnaný',
				d5: 'ženatý',
				d6: 'svobodný',
				d7: 'děti',
				d8: 'vdovec',
				d9: 'bez dětí',
				d10: 's přítelem',
				d11: 's přítelkyní',
				d12: 'oddaný',
				d13: 've vztahu',
				d14: 'sezdaný',
				d15: 'vdaná',
				d16: 'ovdovělý',
				d17: 'šťastný',
				d18: 'nespokojený',
				d19: 'bohatý',
				d20: 'chudý',
			})
		),
		Ethnics: new Map(
			Object.entries({
				e1: 'český',
				e2: 'slovenský',
				e3: 'rusko',
				e4: 'cikán',
				e5: 'černoch',
				e6: 'křesťan',
				e7: 'muslim',
				e8: 'žid',
				e9: 'americký',
				e10: 'německý',
				e11: 'francouzský',
				e12: 'italský',
				e13: 'španělský',
				e14: 'brazilský',
				e15: 'japonský',
				e16: 'čínský',
				e17: 'indický',
				e18: 'africký',
				e19: 'arabský',
				e20: 'turecký',
			})
		),
		Services: new Map(
			Object.entries({
				f1: 'vezmu jakoukoliv práci',
				f2: 'do startupu za podíl',
				f3: 'do projektu za mzdu',
				f4: 'testujuuuuu',
				f5: 'masér',
				f6: 'fotograf',
				f7: 'grafik',
				f8: 'designer',
				f9: 'programátor',
				f10: 'copywriter',
				f11: 'architekt',
				f12: 'inženýr',
				f13: 'stavebník',
				f14: 'elektrikář',
				f15: 'zahradník',
				f16: 'kuchař',
				f17: 'prodavač',
				f18: 'účetní',
				f19: 'recepci',
				f20: 'řidič',
			})
		),
	})
);

export const EVENT_MINI_KEYS: string[] = ['id', 'title', 'imgVers'];
export const EVENT_META_KEYS: string[] = ['priv', 'owner', 'cityID', 'type', 'starts', 'surely', 'maybe', 'comments', 'score', 'basiVers', 'detaVers'];
export const EVENT_BASICS_KEYS: string[] = ['location', 'place', 'shortDesc', 'title', 'ends', 'cityID', 'imgVers'];
export const EVENT_DETAILS_KEYS: string[] = ['meetHow', 'meetWhen', 'organizer', 'contacts', 'links', 'detail', 'fee', 'takeWith'];
export const EVENT_COLUMNS: string = ['id', ...EVENT_META_KEYS, ...EVENT_BASICS_KEYS, ...EVENT_DETAILS_KEYS, 'flag']
	.map(key => `e.${key}`)
	.concat('ST_Y(e.coords) as lat,ST_X(e.coords) as lng, c.city')
	.join(',');

export const USER_MINI_KEYS: string[] = ['id', 'first', 'last', 'imgVers'];
export const USER_META_KEYS: string[] = ['id', 'priv', 'birth', 'gender', 'indis', 'basics', 'groups', 'score', 'imgVers', 'basiVers'];
export const USER_BASI_KEYS: string[] = ['first', 'last', 'shortDesc', 'exps', 'favs'];
export const USER_GENERIC_KEYS: string[] = [...USER_META_KEYS, ...USER_BASI_KEYS];
export const USER_UTILITY_KEYS: string[] = ['cities', 'askPriv', 'defPriv'];
export const USER_PROFILE_KEYS: string[] = [...USER_GENERIC_KEYS, ...USER_UTILITY_KEYS];

export const FRIENDLY_MEETINGS = new Map(
	Object.entries({
		a1: { en: 'outdoors', cz: 'venku', quick: 'chci ven' },
		a2: { en: 'beer', cz: 'pivko', quick: 'na pivko' },
		a3: { en: 'coffee', cz: 'káva', quick: 'na kávu' },
		a4: { en: 'games', cz: 'hravé', quick: 'zahrajem' },
		a5: { en: 'indoors', cz: 'uvnitř', quick: 'zalézt' },
		a6: { en: 'party', cz: 'pařba', quick: 'zapařit' },
		a7: { en: 'discuss', cz: 'diskuzní', quick: 'diskuzi' },
		a8: { en: 'english', cz: 'anglicky', quick: 'speakřit' },
		a9: { en: 'exercise', cz: 'cvičení', quick: 'zacvičit' },
		a10: { en: 'dogs', cz: 's pejsky', quick: 's pejsky' },
		a11: { en: 'teens', cz: 'teens', quick: 'slezinu' },
		a12: { en: 'singles', cz: 'nezadaní', quick: 'seznámit' },
		a13: { en: 'business', cz: 'business', quick: 'business' },
		a14: { en: 'nature', cz: 'příroda', quick: 'do přírody' },
		a15: { en: 'seniors', cz: 'senioři', quick: 'se staršími' },
		a16: { en: 'gypsies', cz: 's romy', quick: 's romy' },
	})
);

export const BENEFICIAL_EVENTS = new Map(
	Object.entries({
		b1: { en: 'volunteering', cz: 'dobrovolné' },
		b2: { en: 'wellbeing', cz: 'duševní' },
		b3: { en: 'critical', cz: 'kritické' },
		b4: { en: 'health', cz: 'zdravotní' },
		b5: { en: 'environment', cz: 'ekologické' },
		b6: { en: 'charity', cz: 'charitní' },
		b7: { en: 'social', cz: 'sociální' },
		b8: { en: 'animal', cz: 'zvířecí' },
		b9: { en: 'spiritual', cz: 'duchovní' },
		b10: { en: 'educational', cz: 'vzdělávací' },
		b11: { en: 'protest', cz: 'protestní' },
		b12: { en: 'fitness', cz: 'fitness' },
	})
);

export const CULTURAL_EVENTS = new Map(
	Object.entries({
		c1: { en: 'textile', cz: 'textil' },
		c2: { en: 'furniture', cz: 'nábytek' },
		c3: { en: 'transport', cz: 'doprava' },
		c4: { en: 'tourism', cz: 'turistika' },
		c5: { en: 'history', cz: 'historie' },
		c6: { en: 'deedjey', cz: 'dídžej' },
		c7: { en: 'food', cz: 'gastro' },
		c8: { en: 'funny', cz: 'zábavné' },
		c9: { en: 'family', cz: 'rodinné' },
		c10: { en: 'concert', cz: 'koncert' },
		c11: { en: 'dating', cz: 'seznamka' },
		c12: { en: 'festival', cz: 'festival' },
	})
);

export const PROFESSIONAL_EVENTS = new Map(
	Object.entries({
		d1: { en: 'chemie', cz: 'chemistry' },
		d2: { en: 'environment', cz: 'prostředí' },
		d3: { en: 'physics', cz: 'fyzika' },
		d4: { en: 'technology', cz: 'technologie' },
		d5: { en: 'economy', cz: 'ekonomie' },
		d6: { en: 'finances', cz: 'finance' },
		d7: { en: 'marketing', cz: 'marketing' },
		d8: { en: 'psychology', cz: 'psychologie' },
		d9: { en: 'design', cz: 'design' },
		d10: { en: 'medicine', cz: 'medicína' },
		d11: { en: 'IT', cz: 'IT' },
		d12: { en: 'management', cz: 'management' },
	})
);

export const REGEXES = {
	name: /^[\p{L}\s'-]+$/u,
	favouriteExpertTopic: /^[\p{L}][\p{L}\s]*[\p{L}]$/u,
	email: /^(?=.{1,254})(?=.{1,64}@)[a-zA-Z0-9!#$%&'*+/=?^_`{|}~.-]+@(?:(?=[a-zA-Z0-9-]{1,63}\.)(xn--)?[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*\.){1,8}(?=[a-zA-Z]{2,63})(xn--[a-zA-Z0-9]{1,59})?[a-zA-Z]{2,63}$/,
} as const;

export const MAX_CHARS = {
	favourExpertTopics: 200,
	userShortDesc: 600,
} as const;

export const MIN_CHARS = {
	favourExpertTopic: 3,
	password: 8,
} as const;

export const MIN_COUNTS = {
	favouriteTopics: 2,
} as const;

export const MAX_COUNTS = {
	cities: 4,
	indis: 5,
	basics: 8,
	groups: 10,
} as const;

export const FOUNDATION_LOADS = { init: 'init', fast: 'fast', auth: 'auth', cities: 'cities', topEvents: 'topEvents' } as const;

export const REVERT_EMAIL_DAYS = 14;
export const EXPIRATIONS = {
	accessToken: '20m', // Access token
	refreshToken: '7d', // Refresh token
	authToken: '5m', // Temporary tokens (verify, reset)
	verifyMailLink: '30m', // Unintroduced user token
	revertEmailChangeLink: `${REVERT_EMAIL_DAYS}d`, // Email revert window
} as const;

export const INTERVALS = {
	authRotation: 30 * 24 * 60 * 60 * 1000,
} as const;

export const ALLOWED_IDS = {
	indis: new Set(Array.from(USER_INDICATORS.keys())),
	groups: new Set(Array.from(USER_GROUPS.values()).flatMap(group => Array.from(group.keys()))),
	basics: new Set(Array.from(BASIC_TOPICS.keys())),
	type: new Set([FRIENDLY_MEETINGS, CULTURAL_EVENTS, PROFESSIONAL_EVENTS, BENEFICIAL_EVENTS].flatMap(event => Array.from(event.keys()))),
} as const;
