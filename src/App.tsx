import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Properties from './pages/Properties'
import PropertyDetail from './pages/PropertyDetail'
import StorageUnits from './pages/StorageUnits'
import StorageUnitDetail from './pages/StorageUnitDetail'
import Inventory from './pages/Inventory'
import AddItem from './pages/AddItem'
import ItemDetail from './pages/ItemDetail'
import StagingPlanner from './pages/StagingPlanner'
import Settings from './pages/Settings'

export default function App() {
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
        <Route path="/staging-planner" element={<StagingPlanner />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}
