import type { WallKind } from '../theme';
import { roomsOnSide } from './measure';
import type { Id, Room, State } from './types';

/** An indoor room of the apartment; a balcony is outside. */
export const isInside = (room: Room): boolean => room.inApartment && !room.outdoor;

/** The rooms on side A and on side B. */
function beside(state: State, wallId: Id): Room[][] {
  return (['A', 'B'] as const).map(side => {
    const ids = roomsOnSide(state, wallId, side);
    return state.rooms.filter(r => ids.includes(r.id));
  });
}
const exterior = ([a, b]: Room[][]) => [...a, ...b].some(r => r.outdoor) || a.some(isInside) !== b.some(isInside);

export const isExterior = (state: State, wallId: Id): boolean => exterior(beside(state, wallId));
export function wallKind(state: State, wallId: Id): WallKind {
  const status = state.walls.find(w => w.id === wallId)?.status;
  if (status === 'removed' || status === 'moved') return status;
  if (status === 'new') return 'added';
  const rooms = beside(state, wallId);
  if (rooms.flat().some(r => r.isMamad)) return 'mamad';
  return exterior(rooms) ? 'exterior' : 'existing';
}
