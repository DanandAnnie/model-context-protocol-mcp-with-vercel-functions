import { useState } from 'react'
import { Outlet, NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Home,
  Warehouse,
  Package,
  PlusCircle,
  Receipt,
  ArrowRightLeft,
  Zap,
  FileText,
  FileSpreadsheet,
  Settings,
  Menu,
  X,
  LogOut,
  User,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import UpdateBanner from './UpdateBanner'

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/properties', icon: Home, label: 'Properties' },
  { to: '/storage', icon: Warehouse, label: 'Storage Units' },
  { to: '/inventory', icon: Package, label: 'Inventory' },
  { to: '/add-item', icon: PlusCircle, label: 'Add Item' },
  { to: '/scan-receipt', icon: Receipt, label: 'Scan Receipt' },
  { to: '/staging-planner', icon: ArrowRightLeft, label: 'Staging Planner' },
  { to: '/deals', icon: Zap, label: 'Deal Finder' },
  { to: '/tax-report', icon: FileText, label: 'Tax Report' },
  { to: '/year-end-summary', icon: FileSpreadsheet, label: 'Year End Summary' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { profile, team, isLocalMode, signOut } = useAuth()

  return (
    <div className="min-h-screen flex">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-[#0a0a18] text-white transform transition-transform duration-200 ease-in-out lg:translate-x-0 lg:static lg:z-auto flex flex-col ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between h-16 px-4 border-b border-[#1a1a35]">
          <h1 className="text-lg font-bold tracking-tight">Stage Manager</h1>
          <button
            className="lg:hidden p-1 rounded hover:bg-[#1e1e3a]"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={20} />
          </button>
        </div>
        <nav className="flex-1 mt-4 px-2 space-y-1 overflow-y-auto">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-violet-600/20 text-violet-300 border-l-2 border-violet-500'
                    : 'text-slate-500 hover:bg-[#151530] hover:text-white'
                }`
              }
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* User footer */}
        {!isLocalMode && profile && (
          <div className="border-t border-[#1a1a35] p-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 bg-violet-600/30 rounded-full flex items-center justify-center flex-shrink-0">
                <User size={14} className="text-violet-300" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white truncate">
                  {profile.display_name || profile.email.split('@')[0]}
                </p>
                {team && (
                  <p className="text-xs text-slate-500 truncate">{team.name}</p>
                )}
              </div>
            </div>
            <button
              onClick={signOut}
              className="flex items-center gap-2 w-full px-3 py-2 text-xs text-slate-500 hover:text-white hover:bg-[#1e1e3a] rounded-lg transition-colors"
            >
              <LogOut size={14} />
              Sign Out
            </button>
          </div>
        )}
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        <UpdateBanner />
        <header className="h-16 bg-[#0a0a18] border-b border-[#1a1a35] flex items-center px-4 lg:px-6 sticky top-0 z-30">
          <button
            className="lg:hidden p-2 -ml-2 rounded-lg hover:bg-[#1e1e3a] text-slate-500"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={20} />
          </button>
          <div className="ml-2 lg:ml-0 text-sm text-slate-500">
            Staging Inventory Manager
          </div>
        </header>
        <main className="flex-1 p-4 lg:p-6 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
