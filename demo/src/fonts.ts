import { loadFont as loadSans } from '@remotion/google-fonts/WorkSans'
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono'
import { loadFont as loadDisplay } from '@remotion/google-fonts/InstrumentSerif'

loadSans('normal', { weights: ['400', '500', '600'], subsets: ['latin'] })
loadMono('normal', { weights: ['400', '500'], subsets: ['latin'] })
loadDisplay('normal', { weights: ['400'], subsets: ['latin'] })
