function HeaderImage({ fadedIn, isLastVisible = false, thisIs, currentSection, isIntroduction }: any) {
	const src = {
		home: {
			imgSrc: 'namestiSvobody.jpg',
		},
		Welcome: {
			imgSrc: 'introduction/Personals.png',
			title: 'Vítej v Ministerře',
			subtitle: 'Jsme rádi, že jsi tady. Připrav se na krátký průvodce tvorbou profilu, který ti pomůže najít zajímavé lidi ve tvém okolí.',
		},
		Personals: {
			imgSrc: 'introduction/Personals.png',
			title: 'Nezbytné formality',
			subtitle: 'Začněme základními osobními informacemi. Potřebujeme ověřit tvůj věk kvůli zákonným požadavkům a vytvořit tvůj autentický profil.',
		},
		Cities: {
			imgSrc: 'introduction/Cities.png',
			title: 'Vyhledej si města',
			subtitle: 'Přidej města, kde se pohybuješ nebo bys rád navázal nové kontakty. První město bude tvým domovským místem.',
		},
		Indis: {
			imgSrc: 'introduction/Indis.png',
			title: 'Zvol si indikátory',
			subtitle: 'Vyber charakteristiky, které tě nejlépe vystihují. Pomohou ostatním lépe tě poznat a najít společné zájmy.',
		},
		Basics: {
			imgSrc: 'introduction/Basics.png',
			title: 'Vyber progresivní témata',
			subtitle: 'Vyber alespoň 3 témata, která tě zajímají a o kterých si rád povídáš. Budou základem pro tvoje budoucí konverzace.',
		},
		Favex: {
			title: 'Poděl se o vlastní témata',
			subtitle: 'Zadej svá oblíbená konverzační témata. Můžeš přidat jak témata, o kterých si rád povídáš, tak ta, ve kterých jsi odborník.',
		},
		Picture: {
			title: 'Nahraj profilovou fotku',
			subtitle: 'Přidej svou fotografii, abys vypadal důvěryhodněji a měl větší šanci na úspěšné navázání kontaktů.',
		},
		Traits: {
			title: 'Přidej se k zájmovým skupinám',
			subtitle: 'Připoj se ke skupinám, které odpovídají tvým zájmům. Najdeš v nich lidi se stejnými koníčky a vášněmi.',
		},
	};

	const defaultTexts = {
		title: 'Vítej v systému Ministerra',
		subtitle: 'Ministerra je vyspělý networkingový systém pro česká města a obce s arzenálem unikátních mechanismů pro zdravější, dynamičtější a inteligentnější společnost a také tvůj bohatší společenský život a volný čas. Přejeme Ti příjemný zážitek při seznamování :-)',
	};

	const currentTexts = currentSection && src[currentSection] ? src[currentSection] : defaultTexts;

	if (!src[thisIs || currentSection]) return null;
	else
		return (
			<header-image class={`posRel block ${!isLastVisible && thisIs !== 'home' ? 'marBotM' : thisIs === 'home' ? 'hvh85 mh80 ' : 'marBotS'} maskTopXxs   textAli posRel pointer w100`}>
				{/* MAIN IMAGE ------------------------------------------ */}
				<img title="Background image" className={`${!fadedIn || fadedIn.includes('Header') ? 'fadedIn' : ''} fadingIn ${thisIs === 'home' ? 'hvh70 mh75' : isLastVisible ? 'hvh50  selfStart' : 'hvh25 '} cover   maskLowXs  w100`} src={`${import.meta.env.VITE_FRONT_END}/headers/${src[thisIs || currentSection].imgSrc}`} />

				{/* PAGE BUTTONS ---------------------------------------- */}
				{!isIntroduction && (
					<page-bs class="flexRow posAbs center spaceBet w100 boRadS marAuto">
						<button className="bgTransXs borLeftThick  bHover   miw4 fs20 boldXs mih6 shaTop">{'<'}</button>
						<button className="bgTransXs borRightThick  bHover fs20 boldXs miw4 mih6 shaTop">{'>'}</button>
					</page-bs>
				)}

				{/* HEADER TEXTS ---------------------------------------- */}
				<content-wrapper class={`${!fadedIn || fadedIn.includes('HeaderTexts') ? 'fadedIn' : ''} fadingIn textAli fPadHorS  padBotS  boRadXs  posAbs botCen flexCol marAuto  w100 `}>
					{/* CENTER IMAGE (LOGO) --------------------------------- */}
					{!isIntroduction && <img title="Logo" className={`marAuto maskLow moveDown bor2White  posRel cover bgTrans shaWhite w30 ${isIntroduction ? 'mw30 marBotM' : 'mw25'}  boRadS`} src="https://png.pngtree.com/png-clipart/20211009/original/pngtree-letter-m-logo-png-design-vector-png-image_6841484.png" />}
					{currentSection ? (
						<strong className={`tDarkBlue  lh1 tShaWhiteXl xBold ${isLastVisible ? 'fs45' : 'fs35'}`}>{currentTexts.title}</strong>
					) : (
						<texts-wrapper class="block textAli">
							<span className="fs22 downTinyBit posRel block lh1-2 bold      ">Vítá Tě </span>
							<span className="xBold  fs40">Ministerra</span>
							<span className="fs44 xBold tDarkBlue  tShaWhite mw180   ">Brno</span>
						</texts-wrapper>
					)}
					<span className="fs13 lh1 w100 inlineBlock  mw160 marAuto  marTopS ">{currentTexts.subtitle}</span>
				</content-wrapper>
			</header-image>
		);
}
export default HeaderImage;
