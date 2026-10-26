/** Esqueleto genérico de página enquanto os dados carregam. */
export function PageSkeleton() {
  return (
    <div className="page-skeleton" aria-busy="true" aria-label="Carregando">
      <div className="skeleton" style={{ width: 220, height: 14 }} />
      <div className="skeleton" style={{ height: 88, borderRadius: 14 }} />
      <div className="page-skeleton__grid">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="skeleton" style={{ height: 150, borderRadius: 12 }} />
        ))}
      </div>
    </div>
  );
}
