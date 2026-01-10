import DateTimePicker from './DateTimePicker';
import { useLayoutEffect, useState } from 'react';
import { MAX_CHARS } from '../../../shared/constants';

function Personals(props) {
	const { data, superMan, inform = [] } = props;
	const { first, last, birth, gender } = data || {},
		[showDatePicker, setShowDatePicker] = useState(false);

	// NORMALIZE BIRTH -----------------------------------------------------------
	// App state may store birth as ms (preferred) or as a Date (picker output).
	const birthDate = birth instanceof Date ? birth : typeof birth === 'number' ? new Date(birth) : null;

	// CALCULATE AGE -------------------------------------------------------------
	function calculateAge(birth, today = new Date()) {
		const [age, monthDifference] = [today.getFullYear() - birth.getFullYear(), today.getMonth() - birth.getMonth()];
		return monthDifference < 0 || (monthDifference === 0 && today.getDate() < birth.getDate()) ? age - 1 : age;
	}

	// HIDE PICKER, CALC AGE + CHECK IF PERSONALS CHANGED -------------------------
	useLayoutEffect(() => {
		if (birthDate instanceof Date && showDatePicker) setShowDatePicker(false), superMan('age', calculateAge(birthDate));
	}, [data]);

	return (
		<personals-div class=' mw140 marAuto  w100'>
			{/* PERSONAL DATA INPUTS ----------------------------------------------- */}
			<inputs-wrapper>
				<full-name class='flexCen w100 posRel  gapXs  boRadM  marAuto '>
					{/* FIRST NAME ------------------------------------------------------ */}
					<first-name class='   w50  textAli'>
						<input
							className={`${['noFirstName', 'shortFirstName'].some(str => inform.includes(str)) ? 'borderRed' : 'borBotLight'} shaBlue  miw36 hr5 fs20 boldM w100`}
							placeholder='Jméno'
							type='text'
							name='first'
							maxLength={MAX_CHARS.name}
							onChange={e => {
								// ALLOW UNICODE LETTERS, SPACES, HYPHENS, APOSTROPHES ---
								// Matches backend REGEXES.name: /^[\p{L}\s'-]+$/u
								const value = e.target.value.replace(/[^\p{L}\s'-]/gu, '').replace(/^\s+/, '');
								superMan('first', value);
							}}
							value={first || ''}
						/>
					</first-name>

					{/* LAST NAME ------------------------------------------------------ */}
					<last-name class=' w50    textAli'>
						<input
							className={`${['noLastName', 'shortLastName'].some(str => inform.includes(str)) ? 'borderRed' : 'borBotLight'} miw36 shaBlue  hr5 fs20 boldM w100`}
							placeholder='Příjmení'
							type='text'
							name='last'
							maxLength={MAX_CHARS.name}
							onChange={e => {
								// ALLOW UNICODE LETTERS, SPACES, HYPHENS, APOSTROPHES ---
								// Matches backend REGEXES.name: /^[\p{L}\s'-]+$/u
								const value = e.target.value.replace(/[^\p{L}\s'-]/gu, '').replace(/^\s+/, '');
								superMan('last', value);
							}}
							value={last || ''}
						/>
					</last-name>
				</full-name>

				{!['first', 'last'].some(str => inform.includes(str)) && <blue-divider class='hr0-5 borTop zin1 block borRed bInsetBlueTopXl borTop bgTrans posRel w90 mw100 marAuto' />}
				{/* AGE / GENDER / BIRTH TRIGGER ------------------------------------------------------ */}
				<age-gender-div class='flexCen  wrap  growAll  hr4  aliStretch  w100 mw80 shaBot borderBot  marAuto'>
					<button
						className={`${gender === 'm' ? 'tWhite tSha10  bInsetBlueBotXl fs12' : 'fs11'} ${inform.includes('noGender') ? 'borderRed' : ''}    w30  bold `}
						onClick={() => superMan('gender', 'm')}>
						Muž
					</button>
					<button
						className={`${inform.includes('noBirthDate') ? 'borderRed' : ''} ${showDatePicker ? 'borRed posRel  arrowDown1 bDarkBlue tWhite' : ''}  w40 padVerXxs noGap`}
						onClick={() => (superMan('birth', null), setShowDatePicker(!showDatePicker))}>
						{!showDatePicker && (
							<span className='fs12 lh1 block  boldS'>{birthDate instanceof Date ? `${calculateAge(birthDate)} let` : data.age ? `${data.age} let` : 'Datum narození'}</span>
						)}
						{showDatePicker && <span className={`tRed padHorM  bold fs12 padVerXxxxs    posRel lh1`}>Skrýt datumář</span>}
					</button>
					<button className={`${gender === 'f' ? 'tWhite bBlue fs12' : 'fs11'} ${inform.includes('noGender') ? 'borderRed' : ''} w30     bold  `} onClick={() => superMan('gender', 'f')}>
						Žena
					</button>
				</age-gender-div>

				{/* BIRTH DATE PICKER ----------------------------------------------- */}
				{showDatePicker && (
					<birth-date class={'block marTopS '}>
						<DateTimePicker superMan={superMan} starts={birthDate} prop={'birth'} />
						{birthDate instanceof Date && (
							<button
								onClick={() => setShowDatePicker(false)}
								className='bgTransXs tGreen shaBlue borderRed   bDarkBlue  tWhite  marTopS  tRed zinMax borderBot  posRel padAllXs boldM fs15  boRadXs w50 marAuto mw50'>
								Potvrdit datum narození
							</button>
						)}
					</birth-date>
				)}
			</inputs-wrapper>
		</personals-div>
	);
}

export default Personals;
