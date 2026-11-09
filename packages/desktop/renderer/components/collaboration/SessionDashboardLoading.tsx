export default function SessionDashboardLoading() {
  return <div className="session-dashboard-loading" role="status" aria-live="polite" aria-label="正在加载会话总览" aria-busy="true">
    <div className="session-dashboard-loading-cards" aria-hidden="true">
      {[0, 1, 2].map(index => <div className="session-dashboard-loading-card" key={index}>
        <span className="session-dashboard-loading-icon"/>
        <span className="session-dashboard-loading-lines"><i/><i/></span>
        <span className="session-dashboard-loading-dot"/>
      </div>)}
    </div>
  </div>;
}
