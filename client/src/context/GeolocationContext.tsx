import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import { Coordinates } from "../types";

interface GeolocationResult {
  coords: Coordinates;
  usingFallback: boolean;
}

interface GeolocationContextType {
  coords: Coordinates | null;
  usingFallback: boolean;
  loading: boolean;
}

const FALLBACK_COORDS: Coordinates = { lat: 18.6298, lng: 73.7997 };

const getIpLocation = async (): Promise<GeolocationResult> => {
  try {
    const res = await fetch("https://ipwho.is/");
    const data = await res.json();
    if (
      data &&
      data.success &&
      typeof data.latitude === "number" &&
      typeof data.longitude === "number"
    ) {
      console.log(
        "IP-based Geolocation success:",
        data.city,
        data.latitude,
        data.longitude,
      );
      return {
        coords: { lat: data.latitude, lng: data.longitude },
        usingFallback: false,
      };
    }
  } catch (e) {
    console.warn("IP geolocation lookup failed:", e);
  }
  return { coords: FALLBACK_COORDS, usingFallback: true };
};

const getCurrentPosition = (): Promise<GeolocationResult> => {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      console.log("Geolocation not supported, checking IP location");
      getIpLocation().then(resolve);
      return;
    }

    let hasResolved = false;
    const finish = (result: GeolocationResult) => {
      if (!hasResolved) {
        hasResolved = true;
        resolve(result);
      }
    };

    // First attempt high accuracy (GPS / WiFi triangulation for street-level precision)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        console.log(
          "High-accuracy Geolocation success:",
          position.coords.latitude,
          position.coords.longitude,
        );
        finish({
          coords: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          },
          usingFallback: false,
        });
      },
      (highAccError) => {
        console.warn(
          "High-accuracy geolocation failed, trying standard accuracy:",
          highAccError.message,
        );
        // Fallback to standard accuracy
        navigator.geolocation.getCurrentPosition(
          (position) => {
            console.log(
              "Standard Geolocation success:",
              position.coords.latitude,
              position.coords.longitude,
            );
            finish({
              coords: {
                lat: position.coords.latitude,
                lng: position.coords.longitude,
              },
              usingFallback: false,
            });
          },
          (standardError) => {
            console.warn(
              "Standard geolocation failed, falling back to IP:",
              standardError.message,
            );
            getIpLocation().then(finish);
          },
          { enableHighAccuracy: false, timeout: 5000, maximumAge: 30000 },
        );
      },
      { enableHighAccuracy: true, timeout: 7000, maximumAge: 0 },
    );

    // Safety timeout in case browser hangs on prompt
    setTimeout(() => {
      if (!hasResolved) {
        console.log("Geolocation prompt timeout, checking IP location");
        getIpLocation().then(finish);
      }
    }, 8000);
  });
};

const GeolocationContext = createContext<GeolocationContextType | undefined>(
  undefined,
);

export const GeolocationProvider = ({ children }: { children: ReactNode }) => {
  const [coords, setCoords] = useState<Coordinates | null>(null);
  const [usingFallback, setUsingFallback] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCurrentPosition()
      .then((result) => {
        setCoords(result.coords);
        setUsingFallback(result.usingFallback);
      })
      .catch((err) => {
        console.error("Geolocation failed:", err);
        setCoords(FALLBACK_COORDS);
        setUsingFallback(true);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  return (
    <GeolocationContext.Provider value={{ coords, usingFallback, loading }}>
      {children}
    </GeolocationContext.Provider>
  );
};

export const useGeolocation = () => {
  const context = useContext(GeolocationContext);
  if (!context) {
    throw new Error("useGeolocation must be used within a GeolocationProvider");
  }
  return context;
};
