import { useState } from 'react'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import StateBox from './components/StateBox'
import ResultsArea from './components/ResultsArea'
import AnomalySidebar from './components/AnomalySidebar'
import RowDetailModal from './components/RowDetailModal'
import MoLookupPage from './components/MoLookupPage'
import TpgCheckPage from './components/TpgCheckPage'
import CrdTrackerPage from './components/CrdTrackerPage'

const PAGES = [
  { id: 'bom',         label: 'BOM Compare' },
  { id: 'mo',          label: 'MO Lookup' },
  { id: 'tpg-check',   label: 'TPG Check' },
  { id: 'crd-tracker', label: 'CRD Tracker' },
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
      <Header pages={PAGES} activePage={activePage} onNavigate={setActivePage} />

      {activePage === 'mo' && <MoLookupPage onProceedToCompare={proceedToCompare} />}

      {activePage === 'tpg-check' && <TpgCheckPage />}

      {activePage === 'crd-tracker' && <CrdTrackerPage />}

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
