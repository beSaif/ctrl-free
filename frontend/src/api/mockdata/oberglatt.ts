// Demo data for the mock backend, taken from the v4 designs (N04, N06, N08, S01) and the
// starter package (example_lv_positions.csv). Used only when the real backend is not reachable.

export const TENDER_META = {
  name: 'Neubau Primarschule Erlenstrasse, Oberglatt',
  client: 'Gemeinde Oberglatt',
  trade: 'BKP 244 Lüftungsanlagen',
  file_name: 'BKP_244_LV_Lueftung_260804.pdf',
  page_count: 202,
  file_size: 3007418,
  due_at: '2026-09-22T10:00:00',
  meta_sources: { name: 9, due_at: 9, client: 9 },
  submission_rule: {
    page: 9,
    heading: '1.14 Adresse und Frist für die Einreichung des Angebotes',
    text_de:
      'Das vollständige, unterzeichnete Angebot (1-fach Papier sowie 1 USB-Datenträger mit sämtlichen Dateien im pdf-Format und der SIA-Schnittstelle des Leistungsverzeichnisses) ist im verschlossenen Umschlag (Couvert / Schachtel) bei der Beschaffungsstelle Gemeinde Oberglatt, Abteilung Immobilien, Rümlangstrasse 8, 8145 Oberglatt bis zum 22. September 2026, 10.00 Uhr einzureichen.',
    text_en:
      'The complete signed offer (1 paper copy and 1 USB stick with all files as PDF and the SIA interface file of the bill of quantities) is due in a sealed envelope at Gemeinde Oberglatt by 22 September 2026, 10:00.',
    bbox: [70, 300, 525, 380],
  },
  award_criteria: [
    {
      label: 'Preis',
      points: 60,
      page: 9,
      rule_de: 'Das tiefste Angebot erhält die volle Punktzahl. Ein Angebot, das 50% über dem tiefsten liegt, erhält 0 Punkte.',
      rule_en: 'The lowest offer gets full points. An offer 50% above the lowest gets 0.',
    },
  ],
}

export const SYSTEMS = {
  LA01: { code: '244.01', key: 'LA01', name: 'Nebenräume UG', label: '244.01 LA01 Nebenräume UG', pages: [67, 98] },
  LA02: { code: '244.02', key: 'LA02', name: 'Essenräume EG', label: '244.02 LA02 Essenräume EG', pages: [99, 140] },
  LA04: { code: '244.04', key: 'LA04', name: 'Schulzimmer OG', label: '244.04 LA04 Schulzimmer OG', pages: [141, 199] },
} as const

type Sys = keyof typeof SYSTEMS

/** [lv_id, system, page, title_en, qty, unit, product_id, install_code, make, model, section, section_name] */
export interface RawLine {
  lv: string
  sys: Sys
  page: number
  en: string
  de: string
  qty: number
  unit: 'pc' | 'm2'
  product: string
  install: string
  make?: string
  model?: string
  section: string
  sectionName: string
  /** text lines of the block; the line with role qty carries the quantity */
  lines: [string, 'desc' | 'qty' | 'other_qty'][]
  match: { label: string; confidence: number; reason: string }
}

const STRONG = { label: 'Strong', confidence: 0.92, reason: 'Type and size match the tender text' }
const BUDGET = { label: 'Strong', confidence: 0.9, reason: 'Type and size match. The catalogue has only a budget figure for this product' }

const VALVE_SUP: RawLine['lines'] = [
  ['Zuluft - Tellerventil', 'desc'],
  ['aus Kunststoff, mit Luftmengeneinstellung', 'desc'],
  ['Fabrikat   z.B Trox Hesco · Typ z.B Z-LVS', 'desc'],
]
const VAV_ROUND: RawLine['lines'] = [
  ['Volumenstromregler variabel, rund', 'desc'],
  ['mit Stellantrieb, Anschluss an GLT', 'desc'],
  ['Fabrikat   z.B. Trox Hesco · Typ z.B. TVR-D', 'desc'],
]
const SEAL: RawLine['lines'] = [
  ['Brandschutzabschottung EI 30', 'desc'],
  ['für Lüftungskanäle, zertifiziertes System', 'desc'],
  ['Fabrikat   z.B. Flumroc oder gleichwertig', 'desc'],
]

export const LINES: RawLine[] = [
  {
    lv: 'LV0001', sys: 'LA01', page: 78, en: 'Supply air valve, plastic, DN100', de: 'Zuluft-Tellerventil aus Kunststoff, Ø 10 cm',
    qty: 5, unit: 'pc', product: 'P-AIR-001', install: 'DIFFUSER', make: 'Trox Hesco', model: 'Z-LVS', section: 'C', sectionName: 'Armaturen und Instrumente',
    lines: [...VALVE_SUP, ['Grösse     Ø 10 cm          Stk 5', 'qty'], ['           Ø 12.5 cm        Stk 6', 'other_qty']],
    match: { label: 'Strong', confidence: 0.92, reason: 'Type and size match (Ø 10 cm = DN100)' },
  },
  {
    lv: 'LV0002', sys: 'LA01', page: 78, en: 'Supply air valve, plastic, DN125', de: 'Zuluft-Tellerventil aus Kunststoff, Ø 12.5 cm',
    qty: 6, unit: 'pc', product: 'P-AIR-002', install: 'DIFFUSER', make: 'Trox Hesco', model: 'Z-LVS', section: 'C', sectionName: 'Armaturen und Instrumente',
    lines: [...VALVE_SUP, ['Grösse     Ø 10 cm          Stk 5', 'other_qty'], ['           Ø 12.5 cm        Stk 6', 'qty']],
    match: { label: 'Strong', confidence: 0.92, reason: 'Type and size match (Ø 12.5 cm = DN125)' },
  },
  {
    lv: 'LV0003', sys: 'LA01', page: 79, en: 'Exhaust air valve, plastic, DN100', de: 'Abluft-Tellerventil aus Kunststoff, Ø 10 cm',
    qty: 5, unit: 'pc', product: 'P-AIR-003', install: 'DIFFUSER', make: 'Trox Hesco', model: 'LVS', section: 'C', sectionName: 'Armaturen und Instrumente',
    lines: [
      ['Abluft - Tellerventil', 'desc'],
      ['aus Kunststoff, mit Luftmengeneinstellung', 'desc'],
      ['Fabrikat   z.B Trox Hesco · Typ z.B LVS', 'desc'],
      ['Grösse     Ø 10 cm          Stk 5', 'qty'],
    ],
    match: { label: 'Strong', confidence: 0.92, reason: 'Type and size match (Ø 10 cm = DN100)' },
  },
  {
    lv: 'LV0004', sys: 'LA01', page: 79, en: 'Fire damper EI90-S with actuator, DN100', de: 'Brandschutzklappe eingemauert, EI 90-S, Ø 10 cm',
    qty: 4, unit: 'pc', product: 'P-FIR-001', install: 'FIRE_DAMPER', make: 'Trox Hesco', model: 'FKRS-EU / FK2-EU', section: 'C', sectionName: 'Armaturen und Instrumente',
    lines: [
      ['Brandschutzklappen eingemauert', 'desc'],
      ['Feuerwiderstandsklasse EI 90-S', 'desc'],
      ['Klappe Fabrikat z.B. Troxhesco Typ z.B.FKRS-EU', 'desc'],
      ['Grösse (B x H)   10 Ø cm          Stk 4', 'qty'],
    ],
    match: STRONG,
  },
  {
    lv: 'LV0005', sys: 'LA01', page: 80, en: 'Manual balancing damper, galvanized, DN125', de: 'Drosselklappe verzinkt, Ø 12.5 cm',
    qty: 6, unit: 'pc', product: 'P-DAM-001', install: 'DAMPER', section: 'C', sectionName: 'Armaturen und Instrumente',
    lines: [['Drosselklappe', 'desc'], ['mit Handverstellung und Arretierung', 'desc'], ['Grösse     Ø 12.5 cm        Stk 6', 'qty']],
    match: { label: 'Close', confidence: 0.78, reason: 'Type and size match. The tender does not name the finish, galvanised assumed' },
  },
  {
    lv: 'LV0006', sys: 'LA01', page: 80, en: 'Rectangular silencer 400×300×1250 mm', de: 'Schalldämpfer 400 x 300 x 1250 mm',
    qty: 4, unit: 'pc', product: 'P-SIL-001', install: 'SILENCER', make: 'Trox Hesco', model: 'MS-F', section: 'C', sectionName: 'Armaturen und Instrumente',
    lines: [['Schalldämpfer', 'desc'], ['Typ z.B. MS-F/400x300x1250/2x100/P', 'desc'], ['BxHxL   40 x 30 x 125cm', 'desc'], ['Druckverlust   28Pa          Stk 4', 'qty']],
    match: BUDGET,
  },
  {
    lv: 'LV0007', sys: 'LA02', page: 106, en: 'VAV controller 500×300 mm, actuator, Modbus', de: 'Variabler Volumenstromregler eckig 500 x 300 mm, Modbus',
    qty: 4, unit: 'pc', product: 'P-VAV-001', install: 'VAV_CONTROLLER', make: 'Trox Hesco / Belimo', model: 'TVJ-D', section: 'C', sectionName: 'Armaturen und Instrumente',
    lines: [
      ['Variabler Volumenstromregler, eckig', 'desc'],
      ['mit Stellantrieb und Modbus-Schnittstelle', 'desc'],
      ['Fabrikat   z.B. Trox Hesco / Belimo · Typ z.B. TVJ-D', 'desc'],
      ['Grösse  B x H  50 x 30 cm          Stk 4', 'qty'],
    ],
    match: BUDGET,
  },
  {
    lv: 'LV0008', sys: 'LA02', page: 107, en: 'Constant volume controller DN250', de: 'Konstant-Volumenstromregler Ø 25 cm',
    qty: 6, unit: 'pc', product: 'P-CAV-001', install: 'CAV_CONTROLLER', make: 'Trox Hesco', model: 'VFC', section: 'C', sectionName: 'Armaturen und Instrumente',
    lines: [['Konstant-Volumenstromregler', 'desc'], ['Fabrikat   z.B. Trox Hesco · Typ z.B. VFC', 'desc'], ['Grösse     Ø 25 cm          Stk 6', 'qty']],
    match: { label: 'Strong', confidence: 0.92, reason: 'Type and size match (Ø 25 cm = DN250)' },
  },
  {
    lv: 'LV0009', sys: 'LA02', page: 107, en: 'Compact silencer DN100, 900 mm', de: 'Rohrschalldämpfer Ø 10 cm, Länge 90 cm',
    qty: 6, unit: 'pc', product: 'P-SIL-002', install: 'SILENCER', make: 'allvotech', model: 'KOSD 100/900', section: 'C', sectionName: 'Armaturen und Instrumente',
    lines: [['Rohrschalldämpfer', 'desc'], ['Fabrikat   z.B. allvotech · Typ z.B. KOSD 100/900', 'desc'], ['Grösse  Ø 10 cm, Länge 90 cm          Stk 6', 'qty']],
    match: { label: 'Close', confidence: 0.76, reason: 'Size matches. The tender names no make, compact type assumed' },
  },
  {
    lv: 'LV0010', sys: 'LA02', page: 107, en: 'Rectangular duct silencer 600×600×1750 mm', de: 'Schalldämpfer 600 x 600 x 1750 mm',
    qty: 4, unit: 'pc', product: 'P-SIL-003', install: 'SILENCER', make: 'Trox Hesco', model: 'MS-F', section: 'C', sectionName: 'Armaturen und Instrumente',
    lines: [['Schalldämpfer', 'desc'], ['Typ z.B. MS-F/600x600x1750/3x200/P', 'desc'], ['BxHxL   60 x 60 x 175cm', 'desc'], ['Druckverlust   41Pa          Stk 4', 'qty']],
    match: BUDGET,
  },
  {
    lv: 'LV0011', sys: 'LA04', page: 163, en: 'Rectangular silencer 540×400×1250 mm', de: 'Schalldämpfer 540 x 400 x 1250 mm',
    qty: 6, unit: 'pc', product: 'P-SIL-004', install: 'SILENCER', make: 'Trox Hesco', model: 'MS-F', section: 'C', sectionName: 'Armaturen und Instrumente',
    lines: [['Schalldämpfer', 'desc'], ['Typ z.B. MS-F/540x400x1250/2x200/P', 'desc'], ['BxHxL   54 x 40 x 125cm', 'desc'], ['Druckverlust   33Pa          Stk 6', 'qty']],
    match: BUDGET,
  },
  {
    lv: 'LV0012', sys: 'LA04', page: 163, en: 'VAV controller 300×200 mm', de: 'Einkanal-Volumenstromregler TVJ-D 300 x 200 mm',
    qty: 6, unit: 'pc', product: 'P-VAV-002', install: 'VAV_CONTROLLER', make: 'Trox Hesco', model: 'TVJ-D', section: 'C', sectionName: 'Armaturen und Instrumente',
    lines: [['Einkanal-Volumenstromregler', 'desc'], ['Fabrikat   z.B. Trox Hesco · Typ z.B. TVJ-D', 'desc'], ['Grösse  B x H  30 x 20 cm          Stk 6', 'qty']],
    match: BUDGET,
  },
  {
    lv: 'LV0013', sys: 'LA04', page: 164, en: 'VAV controller DN125', de: 'Volumenstromregler variabel, Ø 12.5 cm',
    qty: 10, unit: 'pc', product: 'P-VAV-003', install: 'VAV_CONTROLLER', make: 'Trox Hesco', model: 'TVR-D', section: 'C', sectionName: 'Armaturen und Instrumente',
    lines: [...VAV_ROUND, ['Grösse     Ø 12.5 cm        Stk 10', 'qty'], ['           Ø 16 cm          Stk 6', 'other_qty'], ['           Ø 20 cm          Stk 12', 'other_qty']],
    match: { label: 'Strong', confidence: 0.92, reason: 'Type and size match (Ø 12.5 cm = DN125)' },
  },
  {
    lv: 'LV0014', sys: 'LA04', page: 164, en: 'VAV controller DN160', de: 'Volumenstromregler variabel, Ø 16 cm',
    qty: 6, unit: 'pc', product: 'P-VAV-004', install: 'VAV_CONTROLLER', make: 'Trox Hesco', model: 'TVR-D', section: 'C', sectionName: 'Armaturen und Instrumente',
    lines: [...VAV_ROUND, ['Grösse     Ø 12.5 cm        Stk 10', 'other_qty'], ['           Ø 16 cm          Stk 6', 'qty'], ['           Ø 20 cm          Stk 12', 'other_qty']],
    match: { label: 'Strong', confidence: 0.92, reason: 'Type and size match (Ø 16 cm = DN160)' },
  },
  {
    lv: 'LV0015', sys: 'LA04', page: 164, en: 'VAV controller DN200', de: 'Volumenstromregler variabel, Ø 20 cm',
    qty: 12, unit: 'pc', product: 'P-VAV-005', install: 'VAV_CONTROLLER', make: 'Trox Hesco', model: 'TVR-D', section: 'C', sectionName: 'Armaturen und Instrumente',
    lines: [...VAV_ROUND, ['Grösse     Ø 12.5 cm        Stk 10', 'other_qty'], ['           Ø 16 cm          Stk 6', 'other_qty'], ['           Ø 20 cm          Stk 12', 'qty']],
    match: { label: 'Strong', confidence: 0.92, reason: 'Type and size match (Ø 20 cm = DN200)' },
  },
  {
    lv: 'LV0016', sys: 'LA04', page: 169, en: 'External duct insulation, mineral wool 30 mm', de: 'Thermische Aussendämmung 30/5, Mineralwollmatten 30 mm',
    qty: 52, unit: 'm2', product: 'P-INS-001', install: 'INSULATION_30', section: 'D', sectionName: 'Dämmungen',
    lines: [['Thermische Aussendämmung 30/5', 'desc'], ['aus 30 mm Mineralwollmatten ( = 80 kg/m3)', 'desc'], ['mit Alu-Folie, gestiftet          m2 52', 'qty']],
    match: STRONG,
  },
  {
    lv: 'LV0017', sys: 'LA04', page: 169, en: 'External duct insulation, mineral wool 60 mm', de: 'Thermische Aussendämmung 60/10, Mineralwollplatten 60 mm',
    qty: 12, unit: 'm2', product: 'P-INS-002', install: 'INSULATION_60', section: 'D', sectionName: 'Dämmungen',
    lines: [['Thermische Aussendämmung 60/10', 'desc'], ['aus 60 mm Mineralwollplatten ( = 80 kg/m3)', 'desc'], ['mit Alu-Folie, gestiftet          m2 12', 'qty']],
    match: STRONG,
  },
  {
    lv: 'LV0018', sys: 'LA04', page: 169, en: 'Weatherproof insulation 100 mm, stainless cladding', de: 'Wetterfeste Ummantelung V2A inkl. Abdichtung, Dämmung 100 mm',
    qty: 440, unit: 'm2', product: 'P-INS-003', install: 'INSULATION_EXT', section: 'D', sectionName: 'Dämmungen',
    lines: [
      ['Doppelwandige Blechkanäle mit Ummantelung in V2A', 'desc'],
      ['Thermische Aussendämmung 100/15', 'desc'],
      ['aus 100 mm Mineralwollplatten ( = 80 kg/m3)', 'desc'],
      ['mit Alu-Folie, gestiftet', 'desc'],
      ['Wetterfeste Ummantelung V2A inkl. Abdichtung          m2 440', 'qty'],
    ],
    match: BUDGET,
  },
  {
    lv: 'LV0019', sys: 'LA04', page: 170, en: 'EI30 penetration seal, rectangular 300×200 mm', de: 'Brandschutzabschottung EI 30, rechteckig 30 x 20 cm',
    qty: 4, unit: 'pc', product: 'P-FIR-002', install: 'FIRE_SEAL_RECT', make: 'Flumroc or equivalent', model: 'certified system', section: 'E', sectionName: 'Brandschutz',
    lines: [...SEAL, ['rechteckig   30 x 20 cm          Stk 4', 'qty'], ['rund         Ø 16 cm             Stk 8', 'other_qty']],
    match: STRONG,
  },
  {
    lv: 'LV0020', sys: 'LA04', page: 170, en: 'EI30 penetration seal, circular DN160', de: 'Brandschutzabschottung EI 30, rund Ø 16 cm',
    qty: 8, unit: 'pc', product: 'P-FIR-003', install: 'FIRE_SEAL_ROUND', make: 'Flumroc or equivalent', model: 'certified system', section: 'E', sectionName: 'Brandschutz',
    lines: [...SEAL, ['rechteckig   30 x 20 cm          Stk 4', 'other_qty'], ['rund         Ø 16 cm             Stk 8', 'qty']],
    match: STRONG,
  },
  {
    lv: 'LV0021', sys: 'LA04', page: 171, en: 'Connection angles, wall or ceiling mounting', de: 'Anschlusswinkel für Wand- oder Deckenmontage',
    qty: 8, unit: 'pc', product: 'P-SUP-001', install: 'SUPPORT_SET', section: 'E', sectionName: 'Brandschutz',
    lines: [['Anschlusswinkel', 'desc'], ['für Wand- oder Deckenmontage, verzinkt', 'desc'], ['Satz          Stk 8', 'qty']],
    match: { label: 'Close', confidence: 0.77, reason: 'Matched to a set. Check what one set contains against the tender text' },
  },
  {
    lv: 'LV0022', sys: 'LA04', page: 171, en: 'Inspection cover for fire insulation 400×200 mm', de: 'Revisionsdeckel für Brandschutzdämmung 40 x 20 cm',
    qty: 8, unit: 'pc', product: 'P-FIR-004', install: 'FIRE_ACCESS', make: 'Flumroc or equivalent', model: 'certified system', section: 'E', sectionName: 'Brandschutz',
    lines: [['Revisionsdeckel', 'desc'], ['für Brandschutzdämmung, Kanal 40 x 20 cm', 'desc'], ['Fabrikat   z.B. Flumroc oder gleichwertig          Stk 8', 'qty']],
    match: STRONG,
  },
]

export const SILENCER_RULE =
  'Schalldämpfer ausgebildet als Absorptions- oder Relaxationsschalldämpfer mit breitbandiger Dämpfung. Die Schalldämpfung ist über das ganze Frequenzband anzugeben. Kulissen sind aus nicht brennbarem und nicht hygroskopischem Material, abriebfest bis 25 m/s, mit beidseitiger Lochblechabdeckung sowie mit nicht hygrostatischen Folien (ausgenommen trockene Luft) auszuführen.'
const INSULATION_RULE =
  'Für die Ausführung der Dämmungen gelten die Bestimmungen des SIA und die Richtlinien der IsolSuisse und der örtlichen Vorschriften der Feuerpolizei und Kantonaler Energiefachstellen.'

export const QUOTE_GROUPS = [
  { id: 'ins', title: 'Weatherproof insulation', title_de: 'Wetterfeste Dämmung mit V2A-Ummantelung', lv_ids: ['LV0018'], rule: { text_de: INSULATION_RULE, ref: 'Dämmungen, S. 41', page: 41 } },
  { id: 'sil', title: 'Silencers', title_de: 'Schalldämpfer', lv_ids: ['LV0006', 'LV0010', 'LV0011'], rule: { text_de: SILENCER_RULE, ref: 'Schalldämpfer, S. 39', page: 39 } },
  { id: 'vav', title: 'Air volume controllers', title_de: 'Volumenstromregler', lv_ids: ['LV0007', 'LV0012'], rule: null },
]

const SECTION = '3.3.4 Technische Vorschriften Lüftung / Klima'

export const INSTRUCTIONS = [
  {
    id: 'i_01', type: 'Varianten', page: 36, kind: 'scope', applies_to: [], applies_label: 'Product changes',
    applies_long: 'Any line where you pick a product other than the one specified.',
    why: 'Swapping a product turns that line into a variant that needs a written reason.',
    text_de: 'Sofern mit der Submission andere als vorgeschriebene Materialien offeriert werden, hat dies als Variante mit einer entsprechenden Begründung - z.B. technisch besser oder gleichwertig, preisgünstiger oder ähnliches - zu geschehen.',
    text_en: 'If materials other than those specified are offered with the submission, this must be done as a variant with a corresponding justification, e.g. technically better or equivalent, cheaper or similar.',
  },
  {
    id: 'i_02', type: 'Filter', page: 36, kind: 'cost', applies_to: [], applies_label: 'Air-handling units',
    applies_long: 'Air-handling units (none in the 22-line demo set).',
    why: 'A spare set of filter cells must be supplied, so it belongs in the price.',
    text_de: 'Je 1 Satz Ersatzfilterzellen gleicher Qualität ist mitzuliefern.',
    text_en: 'One set of spare filter cells of the same quality must be supplied with each unit.',
  },
  {
    id: 'i_03', type: 'Kanäle', page: 37, kind: 'scope', applies_to: [], applies_label: 'Duct lines',
    applies_long: 'All duct lines (section B Kanäle).',
    why: 'Sets the construction standard for ducts; no price change if the catalogue items follow it.',
    text_de: 'Kanäle: Generell gemäss Suissetec-Kanalnormen, keine Schiebefälze.',
    text_en: 'Ducts: generally according to Suissetec duct standards, no slide-in seams.',
  },
  {
    id: 'i_04', type: 'Brandschutzklappen', page: 38, kind: 'covered', applies_to: ['LV0004'], applies_label: 'LV0004',
    applies_long: 'LV0004 Fire damper EI90-S DN100, 4 pc, p. 79.',
    why: 'The matched product already includes the actuator and limit switch, so nothing extra to price.',
    text_de: 'Die Brandschutzklappen müssen von der zuständigen Feuerpolizei sowie der kantonalen Gebäudeversicherung anerkannt sein. Kontrollöffnung unmittelbar vor oder nach der Klappe. Die Stellung der Klappe muss von aussen ersichtlich sein. Jede Brandschutzklappe muss mit Motorantrieb inkl. elektrischem Endschalter mit Öffnungs- und Schliesskontakt und Thermostat ausgerüstet sein. (Anzeige der beiden Endstellungen auf dem Schaltschrank).',
    text_en: 'Fire dampers must be approved by the responsible fire police and the cantonal building insurance. Inspection opening directly before or after the damper. The damper position must be visible from outside. Every fire damper must have a motor drive incl. electrical limit switch with open and close contacts and a thermostat (both end positions shown on the control cabinet).',
    confirmed: true,
  },
  {
    id: 'i_05', type: 'Flexible Rohre', page: 38, kind: 'scope', applies_to: [], applies_label: 'Flexible duct lines',
    applies_long: 'Flexible pipe and hose lines (none in the 22-line demo set).',
    why: 'Limits which flexible ducts may be offered.',
    text_de: 'Es dürfen nur flexible Rohre bzw. Schläuche aus nichtbrennbaren Materialien verwendet werden. Der Anschluss ist aus einer mit mindestens 5mm breiten Bride aus Nitrostahl auszuführen.',
    text_en: 'Only flexible pipes or hoses made of non-combustible materials may be used. The connection must be made with a clamp band of nitro steel at least 5 mm wide.',
  },
  {
    id: 'i_06', type: 'Dichtheitsanforderungen', page: 38, kind: 'risk', applies_to: [], applies_label: 'Whole installation',
    applies_long: 'The whole duct installation.',
    why: 'Re-tests and their follow-up costs are ours if the first leak test fails.',
    text_de: 'Die erste Messung wird dem Unternehmer, sofern die Forderungen erfüllt werden, vergütet. Nachprüfungen und allfällige Folgekosten hat der Unternehmer zu tragen.',
    text_en: 'The first measurement is paid to the contractor if the requirements are met. Re-tests and any follow-up costs are borne by the contractor.',
  },
  {
    id: 'i_07', type: 'Schalldämpfer', page: 39, kind: 'scope', applies_to: ['LV0006', 'LV0009', 'LV0010', 'LV0011'], applies_label: 'LV0006, 0009, 0010, 0011',
    applies_long: 'LV0006 (p. 80), LV0009 and LV0010 (p. 107), LV0011 (p. 163).',
    why: 'Three of these lines need a supplier quote. The text is attached to that request so the quote matches the spec.',
    text_de: SILENCER_RULE,
    text_en: 'Silencers designed as absorption or relaxation silencers with broadband attenuation. The attenuation must be stated over the whole frequency band. Splitters must be made of non-combustible, non-hygroscopic material, abrasion-resistant up to 25 m/s, with perforated sheet covers on both sides and with non-hygrostatic foils (except for dry air).',
  },
  {
    id: 'i_08', type: 'Korrosionsschutz', page: 40, kind: 'cost', applies_to: ['LV0021'], applies_label: 'LV0021',
    applies_long: 'LV0021 Connection angles, 8 pc, p. 171, and all hangers.',
    why: 'The tender says galvanised hanging material must be "eingerechnet": included in our price.',
    text_de: 'Sämtliches Aufhängematerial muss in verzinkter Ausführung eingerechnet werden (Dübel und Schrauben promatverzinkt).',
    text_en: 'All hanging material must be included in galvanised design (anchors and screws Promat-galvanised).',
  },
  {
    id: 'i_09', type: 'Transport', page: 40, kind: 'covered', applies_to: [], applies_label: 'Whole installation',
    applies_long: 'The whole installation.',
    why: 'Covered by the 2.5% transport and equipment allowance in Pricing.',
    text_de: 'Der Transport der Materialien zum Montageort ist Sache des Unternehmers.',
    text_en: 'Transporting materials to the installation site is the contractor’s responsibility.',
    confirmed: true,
  },
  {
    id: 'i_10', type: 'Mauer- und Deckendurchführungen', page: 41, kind: 'scope', applies_to: [], applies_label: 'p. 169 Kanal-Aussendämmung',
    applies_long: 'p. 169 "Kanal-Aussendämmung aus 15 mm Mineralwollplatten", 30 m² (outside the demo set).',
    why: 'Describes how wall and ceiling penetrations are wrapped; matches the 15 mm line on p. 169.',
    text_de: 'Mauer- und Deckendurchführungen (exkl. Brandschutzklappen) müssen mit mindestens 15 mm Mineralwollplatten 80 kg/m3 umwickelt werden, die beidseits 10 cm vorstehen.',
    text_en: 'Wall and ceiling penetrations (excl. fire dampers) must be wrapped with at least 15 mm mineral wool boards of 80 kg/m³ projecting 10 cm on both sides.',
  },
  {
    id: 'i_11', type: 'Überschreiten der geforderten Werte', page: 41, kind: 'risk', applies_to: [], applies_label: 'Whole installation',
    applies_long: 'The whole installation, at commissioning.',
    why: 'If noise limits are exceeded, all costs of the fix are ours. Relevant to silencer choice.',
    text_de: 'Ergeben sich bei der Inbetriebnahme Überschreitungen der geforderten Geräuschpegel, werden dem Unternehmer sämtliche im Zusammenhang mit der Änderung entstehenden Kosten belastet.',
    text_en: 'If the required noise levels are exceeded at commissioning, all costs arising from the change are charged to the contractor.',
  },
  {
    id: 'i_12', type: 'Innendämmungen', page: 41, kind: 'scope', applies_to: ['LV0016', 'LV0017', 'LV0018'], applies_label: 'Insulation lines',
    applies_long: 'Insulation lines LV0016–LV0018 (all external insulation).',
    why: 'Internal insulation is not allowed; the matched products are all external.',
    text_de: 'Innendämmungen sind nicht zugelassen.',
    text_en: 'Internal insulation is not permitted.',
  },
].map((i) => ({ ...i, section: SECTION }))

/** The seeded supplier reply that Assist has already read (S01). */
export const SEED_REPLY = {
  id: 'r_1',
  file: 'Supplier reply.pdf',
  received_at: '2026-09-10T08:12:00',
  group: 'sil',
  lines: [
    { lv_id: 'LV0006', pos_no: '1', unit_price: 2480 },
    { lv_id: 'LV0010', pos_no: '2', unit_price: 5150 },
    { lv_id: 'LV0011', pos_no: '3', unit_price: 3720 },
  ],
}

export const PROJECT_PARAMETERS = {
  schema_version: '2.0',
  productivity_factors: { site_efficiency: 0.88, school_logistics: 1.07, mounting_height_school: 1.1, mounting_height_sports_hall: 1.25, timber_interface: 1.08 },
  allowances: { material_waste_pct: 4.0, small_material_pct: 3.5, transport_equipment_pct: 2.5, supplier_package_contingency_pct: 3.0 },
  project_costs: { engineering_hours: 420, engineering_rate_chf_per_h: 145, commissioning_hours: 160, commissioning_rate_chf_per_h: 155, hygiene_inspection_chf: 18000, documentation_chf: 12000 },
  commercial: { overhead_pct: 8.5, target_margin_pct: 5.5, round_to_chf: 1000 },
  stretch_bid_optimization: {
    reference_win_probability: 0.55,
    price_sensitivity_probability_points_per_1pct_price: 0.05,
    strategic_appetite_adjustment: 0.05,
    competition_adjustment: -0.05,
    minimum_probability: 0.05,
    maximum_probability: 0.95,
    scenario_margins_pct: { Aggressive: 2.5, Target: 4.0, Conservative: 6.5 },
  },
}
