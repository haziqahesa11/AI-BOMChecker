import { useState } from 'react'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import StateBox from './components/StateBox'
import ResultsArea from './components/ResultsArea'
import AnomalySidebar from './components/AnomalySidebar'
import RowDetailModal from './components/RowDetailModal'

export default function App() {
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

  return (
    <>
      <Header />
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
  )
}
