import { Link, Route, Routes } from 'react-router-dom'
import { useT } from './i18n'
import { AppLayout, TenderLayout } from './components/Layout'
import { Tenders } from './pages/Tenders'
import { NewTender } from './pages/NewTender'
import { Overview } from './pages/Overview'
import { Lines } from './pages/Lines'
import { LineDetail } from './pages/LineDetail'
import { ChangeProduct } from './pages/ChangeProduct'
import { Instructions } from './pages/Instructions'
import { InstructionDetail } from './pages/InstructionDetail'
import { Pricing } from './pages/Pricing'
import { Export } from './pages/Export'
import { Changes } from './pages/Changes'
import { OutcomePage } from './pages/Outcome'
import { Results } from './pages/Results'
import { Reference } from './pages/Reference'

function NotFound() {
  const t = useT()
  return (
    <main className="max-w-[640px] px-6 py-12 flex flex-col gap-3">
      <h1 className="m-0 text-[24px] font-semibold">{t('Page not found')}</h1>
      <Link to="/">{t('Back to tenders')}</Link>
    </main>
  )
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<Tenders />}>
          <Route path="new" element={<NewTender />} />
        </Route>
        <Route path="/results" element={<Results />} />
        <Route path="/reference" element={<Reference />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="/t/:id" element={<TenderLayout />}>
        <Route index element={<Overview />} />
        <Route path="lines" element={<Lines />} />
        <Route path="lines/:lv" element={<LineDetail />} />
        <Route path="lines/:lv/product" element={<ChangeProduct />} />
        <Route path="instructions" element={<Instructions />} />
        <Route path="instructions/:iid" element={<InstructionDetail />} />
        <Route path="pricing" element={<Pricing />} />
        <Route path="changes" element={<Changes />} />
        <Route path="export" element={<Export />} />
        <Route path="outcome" element={<OutcomePage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
