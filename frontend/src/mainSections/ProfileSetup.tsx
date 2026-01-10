import Basics from '../comp/Basics';
import ImageCropper from '../comp/ImageCropper';
import FavouriteExpertTopics from '../comp/FavouriteExpertTopics';
import Groups from '../comp/Groups';
import Indicators from '../comp/Indicators';
import Personals from '../comp/Personals';
import LocationPicker from '../comp/LocationPicker';
import HeaderImage from '../comp/HeaderImage';
import Welcome from '../comp/Welcome';
import { useLayoutEffect, useRef } from 'react';
import BsDynamic from '../comp/BsDynamic';
import { MAX_CHARS } from '../../../shared/constants';

const informTexts = {
	noGender: 'Vyber své pohlaví',
	noBirthDate: 'Vyber datum narození',
	tooYoung: 'Musíš být starší 13 let',
	noFirstName: 'Zadej své křestní jméno',
	noLastName: 'Zadej své příjmení',
	shortFirstName: 'Křestní jméno musí mít alespoň 2 znaky',
	shortLastName: 'Příjmení musí mít alespoň 2 znaky',
	noCity: 'Přidej alespoň jedno město',
	addBasics: 'Vyber alespoň 3 progresivní témata',
	addFavs: 'Zadej alespoň 2 oblíbená témata',
};

const components = { Welcome: Welcome, Personals: Personals, Cities: LocationPicker, Indis: Indicators, Basics: Basics, Favex: FavouriteExpertTopics, Groups: Groups, Picture: ImageCropper };
const bigButtonSrc = {
	Welcome: 'Pokračovat k osobním údajům',
	Personals: 'K nastavení měst',
	Cities: 'K osobnostním indikátorům',
	Indis: 'K progresivním tématům',
	Basics: 'K vlastním tématům',
	Favex: 'K profilovému obrázku',
	Picture: 'K zájmovým skupinám',
	Groups: 'Vytvořit profil a vstoupit!',
};
// TODO  probably use the header texts when isRegistation to display necessary info, and hide the title texts currently in all components. display the title texts only when isIntroduction is false (and thus header is not visible)

const ProfileSetup = props => {
	const { isIntroduction, visibleSections, data, superMan, curSection, inform } = props;

	const scrollTarget = useRef(null);

	// AUTO SCROLL ON SECTION CHANGE ------------------------------------------
	// Use requestAnimationFrame to ensure DOM has updated before scrolling
	useLayoutEffect(() => {
		if (!isIntroduction) return;
		requestAnimationFrame(() => {
			if (scrollTarget.current) {
				scrollTarget.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
			}
		});
	}, [curSection, isIntroduction]);

	return (
		<profile-setup class='w100 posRel block   boRadL bgTrans'>
			{!isIntroduction && <span className='xBold  inlineBlock marBotXl  borRed padVerXs tDarkBlue textSha fs30'>{'Základní nastavení'}</span>}
			{visibleSections.map((name, index) => {
				const SectionComponent = components[name];
				const isLastVisible = index === visibleSections.length - 1;
				return (
					// SECTIONS WRAPPER --------------------------------------------
					<section-wrapper
						key={name}
						ref={isLastVisible ? scrollTarget : null}
						class={`${!isIntroduction || !isLastVisible ? 'marBotXxl mhvh100' : 'hvh100  mhvh100 mihvh100'} 
						${!isIntroduction && index === 0 ? 'padTopS ' : ''} 
						flexCol  posRel  shaTop`}>
						{/* HEADER IMAGE ---------------------------------------- */}
						<blue-divider class={` hr2 borTop block bInsetBlueTopXl borTop bgTrans  w100  mw120   marAuto   `} />
						{isIntroduction && <HeaderImage isIntroduction={isIntroduction} isLastVisible={isLastVisible} currentSection={name} />}

						<spacing-wrapper class='flexCol fPadHorXxs padBotS  spaceAro h100   posRel'>
							{/* SECTION COMPONENT ---------------------------------------- */}
							<SectionComponent {...props} />
							{isIntroduction && isLastVisible && (
								<submit-and-errors class=''>
									{/* ERROR MESSAGES ---------------------------------------- */}
									{inform.length > 0 && (
										<inform-messages class=' block'>
											{(() => {
												const actualWarnings = Object.keys(informTexts).filter(warn => inform.includes(warn));
												return actualWarnings.map((warning, index) => (
													<span key={warning} className='tRed marRigXs xBold fs16  marBotXxs marTopS lh1 inlineBlock aliCen'>
														{`${index > 0 ? ' + ' : ''}${informTexts[warning]}`}
													</span>
												));
											})()}
										</inform-messages>
									)}
									<BsDynamic
										isIntroduction={true}
										superMan={superMan}
										nowAt={'setup'}
										text={
											inform.includes('finalizing')
												? 'Finalizuji profil ...'
												: inform.includes('Request throttled')
												? 'Chyba serveru, opakuj za 10 sekund'
												: inform.length > 0
												? 'Oprav nedostatky'
												: `${bigButtonSrc[name]} ${index < Object.keys(bigButtonSrc).length - 1 ? `(${index + 2}/${Object.keys(bigButtonSrc).length})` : ''}`
										}
										onClick={() => superMan('bigButton')}
										className={`${inform.length > 0 ? ` shaStrong ${inform.includes('finalizing') ? 'bDarkGreen' : 'bRed'}` : ' bGreen shaStrong'} boRadXs padVerS bHover`}
									/>
								</submit-and-errors>
							)}
						</spacing-wrapper>
					</section-wrapper>
				);
			})}
			{/* "ABOUT ME" TEXT FIELD ------------------------------- */}
			{!isIntroduction && (
				<div className='flexCol marTopL boRadM marBotL fPadHorS w100 marAuto padAllM bgTransXs shaBlueLight posRel'>
					<span className=' xBold fs15 inlineBlock marBotXxs'>Krátké představení</span>
					<p className='fs8 marBotXs mw160 lh1 marAuto '>Pověz ostatním proč by se s tebou měli chtít potkat...</p>
					{typeof data.shortDesc === 'string' && data.shortDesc.length >= MAX_CHARS.userShortDesc && (
						<span className='fs7 tGrey inlineBlock'>Dosažen limit: {MAX_CHARS.userShortDesc} znaků</span>
					)}
					<textarea
						title='Krátké představení'
						placeholder='Pověz ostatním proč by se s tebou měli chtít potkat...'
						className='textArea border boRadM bgTransXs w100 shaBlue boRadM padAllM textAli fsB'
						value={data.shortDesc || ''}
						maxLength={MAX_CHARS.userShortDesc}
						rows={5}
						onChange={e => superMan('shortDesc', e.target.value)}
					/>
				</div>
			)}
		</profile-setup>
	);
};

export default ProfileSetup;
