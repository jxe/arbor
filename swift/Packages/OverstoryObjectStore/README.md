# OverstoryObjectStore

The `ObjectStore` protocol and its implementations: `ObjectOverlay` for a working tree's own unaccepted objects, `LayeredObjectStore` that consults the overlay first, `DirectoryObjectStore` for on-disk stores on iOS, and `HostObjectStore` over a host's object route. Every store verifies bytes against their hash before returning them. Twin: `@overstory/object-store`.
