import { useState } from 'react'
import TabBar from './TabBar'
import RawTable from './RawTable'
import CrdTable from './CrdTable'

const DETAIL_TABS = [
  { id: 'location', label: 'Location' },
  { id: 'crd',      label: 'CRD Cfg' },
  { id: 'fru',      label: 'FRU Spec' },
  { id: 'rackSku',  label: 'Rack SKU' },
]

// Renders a /api/part-detail response as TPG's own Test BOM tab layout
// (Location / CRD Cfg / FRU Spec / Rack SKU) — shared by MoLookupPage's
// embedded preview and the standalone TPG Check page.
export default function PartDetailTabs({ partDetail }) {
  const [activeTab, setActiveTab] = useState('location')

  if (!partDetail) return null

  return (
    <>
      <TabBar tabs={DETAIL_TABS} activeTab={activeTab} onSwitch={setActiveTab} />
      <div className={`tab-panel${activeTab === 'location' ? ' active' : ''}`}>
        <div className="table-wrap">
          <RawTable rows={partDetail.location.rows} />
        </div>
      </div>
      <div className={`tab-panel${activeTab === 'crd' ? ' active' : ''}`}>
        {partDetail.crd.found ? (
          <div className="table-wrap">
            <CrdTable rows={partDetail.crd.rows} />
          </div>
        ) : (
          <p>No CRD reference found for this part number.</p>
        )}
      </div>
      <div className={`tab-panel${activeTab === 'fru' ? ' active' : ''}`}>
        {partDetail.fru.found ? (
          <div className="table-wrap">
            <CrdTable rows={partDetail.fru.rows} />
          </div>
        ) : (
          <p>No FRU spec found for this part number.</p>
        )}
      </div>
      <div className={`tab-panel${activeTab === 'rackSku' ? ' active' : ''}`}>
        {partDetail.rackSku.found ? (
          <div className="table-wrap">
            <CrdTable rows={[partDetail.rackSku.row]} />
          </div>
        ) : (
          <p>No Rack SKU properties found for item "{partDetail.rackSku.itemNumber}".</p>
        )}
      </div>
    </>
  )
}
