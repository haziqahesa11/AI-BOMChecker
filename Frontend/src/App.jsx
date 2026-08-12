import { useState } from 'react'
import Header from './components/Header'
import UpdateBanner from './components/UpdateBanner'
import SearchBar from './components/SearchBar'
import StateBox from './components/StateBox'
import ResultsArea from './components/ResultsArea'
import AnomalySidebar from './components/AnomalySidebar'
import RowDetailModal from './components/RowDetailModal'
import MoLookupPage from './components/MoLookupPage'
import TpgCheckPage from './components/TpgCheckPage'
import TpaHistoryPage from './components/TpaHistoryPage'
import CycleTimePage from './components/CycleTimePage'
import FirstPassYieldPage from './components/FirstPassYieldPage'
import GoldenTemplatePage from './components/GoldenTemplatePage'
import CrdTrackerPage from './components/CrdTrackerPage'
import MsftProjectsPage from './components/MsftProjectsPage'
import NpiLibraryPage from './components/NpiLibraryPage'
import AiDashboardPage from './components/AiDashboardPage'

const PAGES = [
  {
    id: 'test',
    label: 'Test',
    children: [
      { id: 'tpg-check',       label: 'TPG Check' },
      { id: 'tpa-history',     label: 'TPA History' },
      { id: 'mo',              label: 'Create BOM' },
      { id: 'golden-template', label: 'Golden Template' },
      { id: 'cycle-time',      label: 'Cycle Time' },
      { id: 'first-pass-yield', label: 'First Pass Yield' },
      { id: 'ai-dashboard',    label: 'AI Dashboard' },
    ],
  },
  {
    id: 'npi',
    label: 'NPI',
    children: [
      { id: 'crd-tracker', label: 'CRD Tracker' },
      { id: 'npi-library', label: 'NPI Library' },
    ],
  },
  { id: 'msft-projects', label: 'MSFT Projects' },
  { id: 'bom', label: 'BOM Compare' },
]

export default function App() {
  const [activePage, setActivePage]   = useState('home')
  const [activeTab, setActiveTab]     = useState('overview')
  const [data, setData]               = useState(null)
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState(null)
  const [searchPn, setSearchPn]       = useState('')
  const [selectedItem, setSelectedItem] = useState(null)

  async function runCompare(pn) {
    setLoading(true)
    setError(null)
    setData(null)
    setActiveTab('overview')
    setSearchPn(pn)
    try {
      const res = await fetch('/api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partNumber: pn }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error || `HTTP ${res.status}`)
      } else {
        setData(json)
      }
    } catch (e) {
      setError('Network error: ' + e.message)
    } finally {
      setLoading(false)
    }
  }

  const hasSidebar = !!(data && data.comparisons && data.comparisons.length > 0)

  function proceedToCompare(pn) {
    setActivePage('bom')
    runCompare(pn)
  }

  return (
    <>
      <UpdateBanner />
      <Header pages={PAGES} activePage={activePage} onNavigate={setActivePage} />

      {activePage === 'mo' && <MoLookupPage onProceedToCompare={proceedToCompare} />}

      {activePage === 'tpg-check' && <TpgCheckPage />}

      {activePage === 'tpa-history' && <TpaHistoryPage />}

      {activePage === 'golden-template' && <GoldenTemplatePage />}

      {activePage === 'cycle-time' && <CycleTimePage />}

      {activePage === 'first-pass-yield' && <FirstPassYieldPage />}

      {activePage === 'ai-dashboard' && <AiDashboardPage />}

      {activePage === 'crd-tracker' && <CrdTrackerPage />}

      {activePage === 'msft-projects' && <MsftProjectsPage />}

      {activePage === 'npi-library' && <NpiLibraryPage />}

      {activePage === 'bom' && (
        <>
          <SearchBar onSearch={runCompare} loading={loading} />

          <div className="app-body">
            <main>
              {loading && <StateBox type="loading" pn={searchPn} />}
              {!loading && error && <StateBox type="error" message={error} />}
              {!loading && !error && !data && <StateBox type="empty" />}
              {!loading && !error && data && (
                <ResultsArea
                  data={data}
                  activeTab={activeTab}
                  onTabSwitch={setActiveTab}
                  onSelectItem={setSelectedItem}
                />
              )}
            </main>

            {hasSidebar && (
              <AnomalySidebar
                comparisons={data.comparisons}
                onSelect={setSelectedItem}
              />
            )}
          </div>

          {selectedItem && (
            <RowDetailModal item={selectedItem} onClose={() => setSelectedItem(null)} />
          )}
        </>
      )}
    </>
  )
}
