const images = [
  { src: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=800&q=80", alt: "Mountain landscape" },
  { src: "https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=800&q=80", alt: "Lake at sunrise" },
  { src: "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?w=800&q=80", alt: "Cabin by the lake" },
  { src: "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=800&q=80", alt: "Forest path" },
  { src: "https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=800&q=80", alt: "Valley view" },
  { src: "https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=800&q=80", alt: "Sunlit hills" },
];

export default function Gallery() {
  return (
    <section className="container py-20">
      <div className="mx-auto mb-12 max-w-2xl text-center">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Gallery</h2>
        <p className="mt-4 text-muted-foreground">A few of our favourite moments.</p>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        {images.map((img) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={img.src}
            src={img.src}
            alt={img.alt}
            className="aspect-[4/3] w-full rounded-xl object-cover transition-transform hover:scale-[1.02]"
            loading="lazy"
          />
        ))}
      </div>
    </section>
  );
}
