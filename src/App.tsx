import { Routes, Route } from 'react-router-dom'
import { useAuth } from './hooks/useAuth'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Properties from './pages/Properties'
import PropertyDetail from './pages/PropertyDetail'
import StorageUnits from './pages/StorageUnits'
import StorageUnitDetail from './pages/StorageUnitDetail'
import Inventory from './pages/Inventory'
import AddItem from './pages/AddItem'
import ItemDetail from './pages/ItemDetail'
import ScanReceipt from './pages/ScanReceipt'
import StagingPlanner from './pages/StagingPlanner'
import TaxReport from './pages/TaxReport'
import YearEndTaxSummary from './pages/YearEndTaxSummary'
import DealFinder from './pages/DealFinder'
import Settings from './pages/Settings'

export default function App() {
  const { isAuthenticated, loading, isLocalMode } = useAuth()

  // Show loading spinner while checking auth
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 mx-auto" />
          <p className="text-sm text-slate-500 mt-3">Loading...</p>
        </div>
      </div>
    )
  }

  // If Supabase is configured but user isn't logged in, show login page
  if (!isLocalMode && !isAuthenticated) {
    return <Login />
  }

  // Authenticated (or local mode) — show the app
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/properties" element={<Properties />} />
        <Route path="/properties/:id" element={<PropertyDetail />} />
        <Route path="/storage" element={<StorageUnits />} />
        <Route path="/storage/:id" element={<StorageUnitDetail />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/items/:id" element={<ItemDetail />} />
        <Route path="/add-item" element={<AddItem />} />
        <Route path="/scan-receipt" element={<ScanReceipt />} />
        <Route path="/staging-planner" element={<StagingPlanner />} />
        <Route path="/deals" element={<DealFinder />} />
        <Route path="/tax-report" element={<TaxReport />} />
        <Route path="/year-end-summary" element={<YearEndTaxSummary />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}
