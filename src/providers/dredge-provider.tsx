import { useZustandAdapter } from '@dredge/hooks/use-zustand-adapter';
import { getItemAt } from '@dredge/lib/utils';
import { HullData, PackedItem, SlotType } from '@dredge/types';
import { createContext, useContext, useState } from 'react';
import { binPackingAsync } from '@dredge/lib/bin-packing/bin-packing-async';
import { useMediaQuery } from 'react-responsive';
import { toast } from 'sonner';

type DredgeProviderContextType = {
  hull: HullData;
  setHull: (newHull: HullData) => void;
  packedItems: PackedItem[];
  setPackedItems: (items: PackedItem[]) => void;
  toggleSlot: (row: number, col: number) => void;
  isLoading: boolean;
  cancelCalculation: () => void;
  packItems: (newItems: PackedItem[]) => void;
  getEncyclopediaGridSquareSize: () => number;
};

const DredgeProviderContext = createContext<DredgeProviderContextType>(
  {} as DredgeProviderContextType,
);

export const useDredge = () => {
  const context = useContext(DredgeProviderContext);
  if (context === undefined) {
    throw new Error('useDredge must be used within a DredgeProvider');
  }
  return context;
};

export const DredgeProvider = ({ children }: { children: React.ReactNode }) => {
  const { hull, setHull, packedItems, setPackedItems } = useZustandAdapter();
  const [isLoading, setIsLoading] = useState(false);
  const [abortController, setAbortController] =
    useState<AbortController | null>(null);

  const BASE_ENCYCLOPEDIA_GRID_SQUARE_SIZE = 40;
  const isLarge = useMediaQuery({
    query: '(min-width: 1024px)',
  });
  const isMedium = useMediaQuery({
    query: '(min-width: 768px)',
  });

  const getEncyclopediaGridSquareSize = () => {
    if (isLarge) {
      return BASE_ENCYCLOPEDIA_GRID_SQUARE_SIZE;
    }
    if (isMedium) {
      return BASE_ENCYCLOPEDIA_GRID_SQUARE_SIZE * 0.8;
    }
    return BASE_ENCYCLOPEDIA_GRID_SQUARE_SIZE * 0.6;
  };

  const toggleSlot = (row: number, col: number) => {
    // if there is an item in the slot, remove the item
    const item = getItemAt(packedItems, row, col);
    if (item) {
      const newPackedItems = packedItems.filter((i) => i.id !== item.id);
      setPackedItems(newPackedItems);
      return;
    }

    // if there is no item in the slot, toggle the slot
    const newGrid = hull.grid.map((r) => r.slice());
    const slot = newGrid[row][col];
    switch (slot) {
      case SlotType.Locked:
        break;
      case SlotType.Available:
        newGrid[row][col] = SlotType.Damaged;
        break;
      case SlotType.Damaged:
        newGrid[row][col] = SlotType.Available;
        break;
    }
    setHull({ ...hull, grid: newGrid });
  };

  const cancelCalculation = () => {
    if (abortController) {
      abortController.abort();
      setIsLoading(false);
    }
  };

  const packItems = async (newItems: PackedItem[]) => {
    const controller = new AbortController();
    setAbortController(controller);
    setIsLoading(true);

    try {
      const allItems = [...packedItems, ...newItems];
      const packed = await binPackingAsync(
        allItems,
        hull.grid,
        controller.signal,
      );
      if (packed) {
        setPackedItems(packed);
      } else {
        toast.error('No solution found!');
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        toast.error('Calculation aborted');
      } else {
        console.error('Error during calculation:', error);
        toast.error('An error occurred during calculation.');
      }
    } finally {
      setIsLoading(false);
      setAbortController(null);
    }
  };

  return (
    <DredgeProviderContext.Provider
      value={{
        hull,
        setHull,
        packedItems,
        setPackedItems,
        toggleSlot,
        isLoading,
        cancelCalculation,
        packItems,
        getEncyclopediaGridSquareSize,
      }}
    >
      {children}
    </DredgeProviderContext.Provider>
  );
};
