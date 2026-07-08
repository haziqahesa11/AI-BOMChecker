import TabBar from './TabBar'
import RawTable from './RawTable'
import CrdTable from './CrdTable'
import OverviewPanel from './panels/OverviewPanel'
import ComparisonPanel from './panels/ComparisonPanel'

export default function ResultsArea({ data, activeTab, onTabSwitch, onSelectItem }) {
  const { crdFound, crdDataFound } = data

  if (!crdFound) {
    return (
      <>
        <div className="state-box" style={{ borderColor: 'var(--warn-border)', background: 'var(--warn-bg)' }}>
          <div className="icon">⚠️</div>
          <h3 style={{ color: 'var(--warn-fg)' }}>No CRD Reference Found</h3>
          <p>{data.message || ''}</p>
        </div>
        <div className="section-title" style={{ marginTop: '1.25rem' }}>
          BOM Data — {data.bomData.length} rows
        </div>
        <div className="table-wrap">
          <RawTable rows={data.bomData} />
        </div>
      </>
    )
  }

  if (!crdDataFound) {
    return (
      <>
        <div className="state-box" style={{ borderColor: 'var(--warn-border)', background: 'var(--warn-bg)' }}>
          <div className="icon">⚠️</div>
          <h3 style={{ color: 'var(--warn-fg)' }}>CRD Specs Not Found</h3>
          <p>{data.message || ''}</p>
        </div>
        <div className="section-title" style={{ marginTop: '1.25rem' }}>
          BOM Data — {data.bomData.length} rows
        </div>
        <div className="table-wrap">
          <RawTable rows={data.bomData} />
        </div>
      </>
    )
  }

  const tabs = [
    { id: 'overview',   label: 'Overview' },
    { id: 'comparison', label: 'Comparison', count: data.comparisons.filter(c => c.type === 'MATCHED').length },
    { id: 'bom-data',   label: 'BOM Data',   count: data.bomData.length },
    { id: 'crd-specs',  label: 'CRD Specs',  count: data.crdData.length },
  ]

  return (
    <>
      <TabBar tabs={tabs} activeTab={activeTab} onSwitch={onTabSwitch} />

      <div className={`tab-panel${activeTab === 'overview' ? ' active' : ''}`}>
        <OverviewPanel data={data} />
      </div>

      <div className={`tab-panel${activeTab === 'comparison' ? ' active' : ''}`}>
        <ComparisonPanel data={data} onSelectItem={onSelectItem} />
      </div>

      <div className={`tab-panel${activeTab === 'bom-data' ? ' active' : ''}`}>
        <div className="table-wrap">
          <RawTable rows={data.bomData} crdRefRow={data.crdRefRow} />
        </div>
      </div>

      <div className={`tab-panel${activeTab === 'crd-specs' ? ' active' : ''}`}>
        <div className="table-wrap">
          <CrdTable rows={data.crdData} />
        </div>
      </div>
    </>
  )
}
