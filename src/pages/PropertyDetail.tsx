import { useParams, Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Home, Package } from 'lucide-react'
import { useProperties } from '../hooks/useProperties'
import { useItems } from '../hooks/useItems'
import ItemCard from '../components/ItemCard'

export default function PropertyDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { properties, loading: propsLoading } = useProperties()
  const { items, loading: itemsLoading } = useItems()

  const property = properties.find((p) => p.id === id)
  const propertyItems = items.filter((i) => i.current_property_id === id)
  const totalValue = propertyItems.reduce((sum, i) => sum + i.value, 0)
  const loading = propsLoading || itemsLoading

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  if (!property) {
    return (
      <div className="text-center py-12">
        <p className="text-slate-500">Property not found</p>
        <Link to="/properties" className="text-blue-600 text-sm mt-2 inline-block">Back to properties</Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Link
        to="/properties"
        className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700"
      >
        <ArrowLeft size={16} />
        Back to properties
      </Link>

      <div className="bg-white rounded-xl border border-slate-200 p-6">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-blue-50 rounded-lg">
            <Home size={24} className="text-blue-700" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-bold">{property.name}</h1>
            <p className="text-slate-500 text-sm">{property.address}</p>
            {property.city && <p className="text-slate-400 text-sm">{property.city}</p>}
            <div className="flex items-center gap-4 mt-3 text-sm text-slate-600">
              <span>{property.bedrooms} bd / {property.bathrooms} ba</span>
              <span>{property.sqft.toLocaleString()} sqft</span>
              <span className="capitalize">{property.property_type}</span>
            </div>
            {property.notes && (
              <p className="mt-3 text-sm text-slate-500">{property.notes}</p>
            )}
          </div>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Package size={18} />
            Staged Items ({propertyItems.length})
          </h2>
          <span className="text-sm font-medium text-slate-600">
            Total: ${totalValue.toLocaleString()}
          </span>
        </div>

        {propertyItems.length > 0 ? (
          <div className="space-y-2">
            {propertyItems.map((item) => (
              <ItemCard key={item.id} item={item} locationName={property.name} onClick={() => navigate(`/items/${item.id}`)} />
            ))}
          </div>
        ) : (
          <div className="text-center py-12 bg-white rounded-xl border border-slate-200">
            <Package size={36} className="mx-auto text-slate-300 mb-2" />
            <p className="text-slate-400 text-sm">No items staged at this property</p>
            <Link
              to="/staging-planner"
              className="text-blue-600 text-sm mt-2 inline-block hover:text-blue-700"
            >
              Go to Staging Planner
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
