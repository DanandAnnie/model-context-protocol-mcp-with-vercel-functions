import type { ReactNode } from 'react'

interface StatsCardProps {
  title: string
  value: string | number
  icon: ReactNode
  subtitle?: string
  color?: 'blue' | 'green' | 'amber' | 'rose'
}

const colorMap = {
  blue: 'bg-blue-500/15 text-blue-400',
  green: 'bg-green-500/15 text-green-400',
  amber: 'bg-amber-500/15 text-amber-400',
  rose: 'bg-rose-500/15 text-rose-400',
}

export default function StatsCard({ title, value, icon, subtitle, color = 'blue' }: StatsCardProps) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-500">{title}</p>
          <p className="text-2xl font-bold mt-1">{value}</p>
          {subtitle && <p className="text-xs text-slate-400 mt-1">{subtitle}</p>}
        </div>
        <div className={`p-3 rounded-lg ${colorMap[color]}`}>
          {icon}
        </div>
      </div>
    </div>
  )
}
