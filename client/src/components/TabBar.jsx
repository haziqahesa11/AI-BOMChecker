export default function TabBar({ tabs, activeTab, onSwitch }) {
  return (
    <div className="tabs">
      {tabs.map(t => (
        <button
          key={t.id}
          className={`tab-btn${activeTab === t.id ? ' active' : ''}`}
          onClick={() => onSwitch(t.id)}
        >
          {t.label}
          {t.count != null && <span className="cnt">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}
