import React, { useState, useEffect, useCallback, useRef } from "react";
import { RotateCcw, Lightbulb, Flag, Crown, Users, Cpu, Globe, Copy, Check, LogOut } from "lucide-react";
import { createRoom, joinRoom, quickMatch, wsUrlForRoom } from "./api";

/* =========================================================================
   CHESS ENGINE — pure functions, no React here.
   Board: 8x8 array, row 0 = rank 8 (top/black side), row 7 = rank 1 (white).
   col 0 = file a ... col 7 = file h.
   Piece: { type: 'p'|'n'|'b'|'r'|'q'|'k', color: 'w'|'b' }
   ========================================================================= */

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const sq = (r, c) => FILES[c] + (8 - r);

function initialBoard() {
  const empty = () => Array(8).fill(null).map(() => Array(8).fill(null));
  const b = empty();
  const backRank = ["r", "n", "b", "q", "k", "b", "n", "r"];
  for (let c = 0; c < 8; c++) {
    b[0][c] = { type: backRank[c], color: "b" };
    b[1][c] = { type: "p", color: "b" };
    b[6][c] = { type: "p", color: "w" };
    b[7][c] = { type: backRank[c], color: "w" };
  }
  return b;
}

function cloneBoard(board) {
  return board.map((row) => row.map((p) => (p ? { ...p } : null)));
}

const inBounds = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

function initialState() {
  return {
    turn: "w",
    castling: { wK: true, wQ: true, bK: true, bQ: true },
    enPassant: null, // {r,c} square that can be captured to en-passant
    halfmove: 0,
    fullmove: 1,
  };
}

const KNIGHT_DELTAS = [
  [-2, -1], [-2, 1], [-1, -2], [-1, 2],
  [1, -2], [1, 2], [2, -1], [2, 1],
];
const KING_DELTAS = [
  [-1, -1], [-1, 0], [-1, 1], [0, -1],
  [0, 1], [1, -1], [1, 0], [1, 1],
];
const BISHOP_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ROOK_DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

// Squares attacked BY a given color (used for check / castling safety).
function isSquareAttacked(board, r, c, byColor) {
  // Pawn attacks
  const dir = byColor === "w" ? -1 : 1; // pawn of byColor moves toward -dir; it attacks from behind
  const pr = r - dir; // pawn would be one rank "behind" relative to attack direction... see below
  // A byColor pawn attacks squares diagonally forward from itself.
  // So attacker pawn sits at (r + oppDir, c ± 1) where oppDir is opposite of its forward dir.
  const pawnFwd = byColor === "w" ? -1 : 1;
  for (const dc of [-1, 1]) {
    const rr = r - pawnFwd;
    const cc = c + dc;
    if (inBounds(rr, cc)) {
      const p = board[rr][cc];
      if (p && p.color === byColor && p.type === "p") return true;
    }
  }
  // Knight
  for (const [dr, dc] of KNIGHT_DELTAS) {
    const rr = r + dr, cc = c + dc;
    if (inBounds(rr, cc)) {
      const p = board[rr][cc];
      if (p && p.color === byColor && p.type === "n") return true;
    }
  }
  // King
  for (const [dr, dc] of KING_DELTAS) {
    const rr = r + dr, cc = c + dc;
    if (inBounds(rr, cc)) {
      const p = board[rr][cc];
      if (p && p.color === byColor && p.type === "k") return true;
    }
  }
  // Sliding: bishop/queen diagonals
  for (const [dr, dc] of BISHOP_DIRS) {
    let rr = r + dr, cc = c + dc;
    while (inBounds(rr, cc)) {
      const p = board[rr][cc];
      if (p) {
        if (p.color === byColor && (p.type === "b" || p.type === "q")) return true;
        break;
      }
      rr += dr; cc += dc;
    }
  }
  // Sliding: rook/queen orthogonals
  for (const [dr, dc] of ROOK_DIRS) {
    let rr = r + dr, cc = c + dc;
    while (inBounds(rr, cc)) {
      const p = board[rr][cc];
      if (p) {
        if (p.color === byColor && (p.type === "r" || p.type === "q")) return true;
        break;
      }
      rr += dr; cc += dc;
    }
  }
  return false;
}

function findKing(board, color) {
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.color === color && p.type === "k") return { r, c };
    }
  return null;
}

function isInCheck(board, color) {
  const k = findKing(board, color);
  if (!k) return false;
  return isSquareAttacked(board, k.r, k.c, color === "w" ? "b" : "w");
}

// Generate pseudo-legal moves for the piece at (r,c) — does not check for
// leaving own king in check (that filter happens in generateLegalMoves).
function generatePieceMoves(board, state, r, c) {
  const p = board[r][c];
  if (!p) return [];
  const moves = [];
  const opp = p.color === "w" ? "b" : "w";
  const push = (toR, toC, flags = {}) => {
    if (!inBounds(toR, toC)) return;
    const target = board[toR][toC];
    if (target && target.color === p.color) return;
    moves.push({ from: { r, c }, to: { r: toR, c: toC }, piece: p, captured: target, ...flags });
  };

  if (p.type === "p") {
    const dir = p.color === "w" ? -1 : 1;
    const startRow = p.color === "w" ? 6 : 1;
    const promoRow = p.color === "w" ? 0 : 7;
    // forward
    if (inBounds(r + dir, c) && !board[r + dir][c]) {
      if (r + dir === promoRow) {
        for (const promo of ["q", "r", "b", "n"])
          moves.push({ from: { r, c }, to: { r: r + dir, c }, piece: p, captured: null, promotion: promo });
      } else {
        moves.push({ from: { r, c }, to: { r: r + dir, c }, piece: p, captured: null });
        if (r === startRow && !board[r + 2 * dir][c]) {
          moves.push({ from: { r, c }, to: { r: r + 2 * dir, c }, piece: p, captured: null, doubleStep: true });
        }
      }
    }
    // captures
    for (const dc of [-1, 1]) {
      const rr = r + dir, cc = c + dc;
      if (!inBounds(rr, cc)) continue;
      const target = board[rr][cc];
      if (target && target.color === opp) {
        if (rr === promoRow) {
          for (const promo of ["q", "r", "b", "n"])
            moves.push({ from: { r, c }, to: { r: rr, c: cc }, piece: p, captured: target, promotion: promo });
        } else {
          moves.push({ from: { r, c }, to: { r: rr, c: cc }, piece: p, captured: target });
        }
      } else if (state.enPassant && state.enPassant.r === rr && state.enPassant.c === cc) {
        moves.push({ from: { r, c }, to: { r: rr, c: cc }, piece: p, captured: board[r][cc], enPassant: true });
      }
    }
  } else if (p.type === "n") {
    for (const [dr, dc] of KNIGHT_DELTAS) push(r + dr, c + dc);
  } else if (p.type === "k") {
    for (const [dr, dc] of KING_DELTAS) push(r + dr, c + dc);
    // castling
    const rights = state.castling;
    const homeRow = p.color === "w" ? 7 : 0;
    if (r === homeRow && c === 4 && !isInCheck(board, p.color)) {
      const kSide = p.color === "w" ? rights.wK : rights.bK;
      const qSide = p.color === "w" ? rights.wQ : rights.bQ;
      if (kSide && !board[homeRow][5] && !board[homeRow][6]) {
        const rook = board[homeRow][7];
        if (rook && rook.type === "r" && rook.color === p.color &&
            !isSquareAttacked(board, homeRow, 5, opp) && !isSquareAttacked(board, homeRow, 6, opp)) {
          moves.push({ from: { r, c }, to: { r: homeRow, c: 6 }, piece: p, captured: null, castle: "K" });
        }
      }
      if (qSide && !board[homeRow][1] && !board[homeRow][2] && !board[homeRow][3]) {
        const rook = board[homeRow][0];
        if (rook && rook.type === "r" && rook.color === p.color &&
            !isSquareAttacked(board, homeRow, 3, opp) && !isSquareAttacked(board, homeRow, 2, opp)) {
          moves.push({ from: { r, c }, to: { r: homeRow, c: 2 }, piece: p, captured: null, castle: "Q" });
        }
      }
    }
  } else {
    const dirs = p.type === "b" ? BISHOP_DIRS : p.type === "r" ? ROOK_DIRS : [...BISHOP_DIRS, ...ROOK_DIRS];
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (inBounds(rr, cc)) {
        const target = board[rr][cc];
        if (target) {
          if (target.color === opp) push(rr, cc);
          break;
        }
        push(rr, cc);
        rr += dr; cc += dc;
      }
    }
  }
  return moves;
}

function applyMove(board, state, move) {
  const b = cloneBoard(board);
  const s = { ...state, castling: { ...state.castling }, enPassant: null };
  const { from, to, piece } = move;
  b[from.r][from.c] = null;
  if (move.enPassant) {
    b[from.r][to.c] = null; // captured pawn is beside the from square
  }
  let placed = { ...piece };
  if (move.promotion) placed = { type: move.promotion, color: piece.color };
  b[to.r][to.c] = placed;

  if (move.castle === "K") {
    const homeRow = piece.color === "w" ? 7 : 0;
    b[homeRow][5] = b[homeRow][7];
    b[homeRow][7] = null;
  } else if (move.castle === "Q") {
    const homeRow = piece.color === "w" ? 7 : 0;
    b[homeRow][3] = b[homeRow][0];
    b[homeRow][0] = null;
  }

  if (move.doubleStep) {
    s.enPassant = { r: (from.r + to.r) / 2, c: from.c };
  }

  // update castling rights
  if (piece.type === "k") {
    if (piece.color === "w") { s.castling.wK = false; s.castling.wQ = false; }
    else { s.castling.bK = false; s.castling.bQ = false; }
  }
  const clearRookRight = (r, c) => {
    if (r === 7 && c === 0) s.castling.wQ = false;
    if (r === 7 && c === 7) s.castling.wK = false;
    if (r === 0 && c === 0) s.castling.bQ = false;
    if (r === 0 && c === 7) s.castling.bK = false;
  };
  if (piece.type === "r") clearRookRight(from.r, from.c);
  if (move.captured) clearRookRight(to.r, to.c);

  s.halfmove = (piece.type === "p" || move.captured) ? 0 : state.halfmove + 1;
  s.turn = piece.color === "w" ? "b" : "w";
  if (piece.color === "b") s.fullmove = state.fullmove + 1;

  return { board: b, state: s };
}

function generateLegalMoves(board, state, color) {
  const all = [];
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.color === color) {
        const pseudo = generatePieceMoves(board, state, r, c);
        for (const m of pseudo) {
          const { board: nb } = applyMove(board, state, m);
          if (!isInCheck(nb, color)) all.push(m);
        }
      }
    }
  return all;
}

function getGameStatus(board, state) {
  const color = state.turn;
  const moves = generateLegalMoves(board, state, color);
  const check = isInCheck(board, color);
  if (moves.length === 0) {
    if (check) return { status: "checkmate", winner: color === "w" ? "b" : "w" };
    return { status: "stalemate" };
  }
  if (state.halfmove >= 100) return { status: "draw", reason: "50-move rule" };
  // insufficient material
  const pieces = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (board[r][c]) pieces.push(board[r][c]);
  const nonKing = pieces.filter((p) => p.type !== "k");
  if (nonKing.length === 0) return { status: "draw", reason: "insufficient material" };
  if (nonKing.length === 1 && (nonKing[0].type === "b" || nonKing[0].type === "n"))
    return { status: "draw", reason: "insufficient material" };
  if (check) return { status: "check", moves };
  return { status: "playing", moves };
}

function moveToSAN(board, move, legalMovesAtTime, resultingCheck, resultingMate) {
  if (move.castle === "K") return resultingMate ? "O-O#" : resultingCheck ? "O-O+" : "O-O";
  if (move.castle === "Q") return resultingMate ? "O-O-O#" : resultingCheck ? "O-O-O+" : "O-O-O";
  const pieceLetters = { p: "", n: "N", b: "B", r: "R", q: "Q", k: "K" };
  let s = pieceLetters[move.piece.type];
  const capture = !!move.captured;
  if (move.piece.type === "p") {
    if (capture) s += FILES[move.from.c] + "x";
  } else {
    // disambiguation: any other same-type piece that could also move to `to`
    const others = legalMovesAtTime.filter(
      (m) => m.piece.type === move.piece.type && m.piece.color === move.piece.color &&
        m.to.r === move.to.r && m.to.c === move.to.c &&
        !(m.from.r === move.from.r && m.from.c === move.from.c)
    );
    if (others.length) {
      const sameFile = others.some((m) => m.from.c === move.from.c);
      const sameRank = others.some((m) => m.from.r === move.from.r);
      if (!sameFile) s += FILES[move.from.c];
      else if (!sameRank) s += 8 - move.from.r;
      else s += FILES[move.from.c] + (8 - move.from.r);
    }
    if (capture) s += "x";
  }
  s += sq(move.to.r, move.to.c);
  if (move.promotion) s += "=" + pieceLetters[move.promotion].toUpperCase();
  if (resultingMate) s += "#";
  else if (resultingCheck) s += "+";
  return s;
}

/* =========================================================================
   AI — static evaluation + minimax with alpha-beta pruning.
   ========================================================================= */

const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

const PST_PAWN = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [50, 50, 50, 50, 50, 50, 50, 50],
  [10, 10, 20, 30, 30, 20, 10, 10],
  [5, 5, 10, 25, 25, 10, 5, 5],
  [0, 0, 0, 20, 20, 0, 0, 0],
  [5, -5, -10, 0, 0, -10, -5, 5],
  [5, 10, 10, -20, -20, 10, 10, 5],
  [0, 0, 0, 0, 0, 0, 0, 0],
];
const PST_KNIGHT = [
  [-50, -40, -30, -30, -30, -30, -40, -50],
  [-40, -20, 0, 0, 0, 0, -20, -40],
  [-30, 0, 10, 15, 15, 10, 0, -30],
  [-30, 5, 15, 20, 20, 15, 5, -30],
  [-30, 0, 15, 20, 20, 15, 0, -30],
  [-30, 5, 10, 15, 15, 10, 5, -30],
  [-40, -20, 0, 5, 5, 0, -20, -40],
  [-50, -40, -30, -30, -30, -30, -40, -50],
];
const PST_BISHOP = [
  [-20, -10, -10, -10, -10, -10, -10, -20],
  [-10, 0, 0, 0, 0, 0, 0, -10],
  [-10, 0, 5, 10, 10, 5, 0, -10],
  [-10, 5, 5, 10, 10, 5, 5, -10],
  [-10, 0, 10, 10, 10, 10, 0, -10],
  [-10, 10, 10, 10, 10, 10, 10, -10],
  [-10, 5, 0, 0, 0, 0, 5, -10],
  [-20, -10, -10, -10, -10, -10, -10, -20],
];
const PST_ROOK = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [5, 10, 10, 10, 10, 10, 10, 5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [-5, 0, 0, 0, 0, 0, 0, -5],
  [0, 0, 0, 5, 5, 0, 0, 0],
];
const PST_QUEEN = [
  [-20, -10, -10, -5, -5, -10, -10, -20],
  [-10, 0, 0, 0, 0, 0, 0, -10],
  [-10, 0, 5, 5, 5, 5, 0, -10],
  [-5, 0, 5, 5, 5, 5, 0, -5],
  [0, 0, 5, 5, 5, 5, 0, -5],
  [-10, 5, 5, 5, 5, 5, 0, -10],
  [-10, 0, 5, 0, 0, 0, 0, -10],
  [-20, -10, -10, -5, -5, -10, -10, -20],
];
const PST_KING = [
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-30, -40, -40, -50, -50, -40, -40, -30],
  [-20, -30, -30, -40, -40, -30, -30, -20],
  [-10, -20, -20, -20, -20, -20, -20, -10],
  [20, 20, 0, 0, 0, 0, 20, 20],
  [20, 30, 10, 0, 0, 10, 30, 20],
];
const PST = { p: PST_PAWN, n: PST_KNIGHT, b: PST_BISHOP, r: PST_ROOK, q: PST_QUEEN, k: PST_KING };

function evaluateBoard(board) {
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) continue;
      const value = PIECE_VALUES[p.type];
      const pstTable = PST[p.type];
      const pstVal = p.color === "w" ? pstTable[r][c] : pstTable[7 - r][c];
      const total = value + pstVal;
      score += p.color === "w" ? total : -total;
    }
  }
  return score;
}

function orderMoves(moves) {
  return [...moves].sort((a, b) => {
    const av = a.captured ? PIECE_VALUES[a.captured.type] - PIECE_VALUES[a.piece.type] / 10 : 0;
    const bv = b.captured ? PIECE_VALUES[b.captured.type] - PIECE_VALUES[b.piece.type] / 10 : 0;
    return bv - av;
  });
}

function minimax(board, state, depth, alpha, beta, maximizing) {
  const color = state.turn;
  const moves = generateLegalMoves(board, state, color);
  if (moves.length === 0) {
    if (isInCheck(board, color)) return maximizing ? -100000 - depth : 100000 + depth;
    return 0;
  }
  if (depth === 0) return evaluateBoard(board);

  const ordered = orderMoves(moves);
  if (maximizing) {
    let best = -Infinity;
    for (const m of ordered) {
      const { board: nb, state: ns } = applyMove(board, state, m);
      const val = minimax(nb, ns, depth - 1, alpha, beta, false);
      best = Math.max(best, val);
      alpha = Math.max(alpha, val);
      if (beta <= alpha) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const m of ordered) {
      const { board: nb, state: ns } = applyMove(board, state, m);
      const val = minimax(nb, ns, depth - 1, alpha, beta, true);
      best = Math.min(best, val);
      beta = Math.min(beta, val);
      if (beta <= alpha) break;
    }
    return best;
  }
}

function findBestMove(board, state, depth, randomize) {
  const color = state.turn;
  const moves = orderMoves(generateLegalMoves(board, state, color));
  if (moves.length === 0) return null;
  const maximizing = color === "w";
  let scored = moves.map((m) => {
    const { board: nb, state: ns } = applyMove(board, state, m);
    const val = minimax(nb, ns, depth - 1, -Infinity, Infinity, !maximizing);
    return { move: m, val };
  });
  scored.sort((a, b) => (maximizing ? b.val - a.val : a.val - b.val));
  if (randomize) {
    const pool = scored.slice(0, Math.min(3, scored.length));
    return pool[Math.floor(Math.random() * pool.length)].move;
  }
  return scored[0].move;
}

const DIFFICULTY_DEPTH = { easy: 1, medium: 2, hard: 3, expert: 4 };

/* =========================================================================
   PRESENTATION HELPERS
   ========================================================================= */

const PIECE_NAME = { k: "King", q: "Queen", r: "Rook", b: "Bishop", n: "Knight", p: "Pawn" };

function movesFrom(legalMoves, r, c) {
  return legalMoves.filter((m) => m.from.r === r && m.from.c === c);
}

/* =========================================================================
   ONLINE PLAY — talks to the real Django/Channels backend.
   REST (game/views.py) creates/joins rooms; the server is authoritative for
   legality (python-chess) and broadcasts moves over a WebSocket
   (game/consumers.py). We reconstruct local board/gameState from the FEN the
   server sends rather than re-deriving moves locally, so the two engines can
   never disagree.
   ========================================================================= */

function squareToAlgebraic(square) {
  return sq(square.r, square.c);
}

function algebraicToSquare(alg) {
  const c = FILES.indexOf(alg[0]);
  const r = 8 - Number(alg[1]);
  return { r, c };
}

// Parse a FEN string into this app's board/gameState representation.
function boardStateFromFEN(fen) {
  const parts = fen.trim().split(/\s+/);
  const [placement, turn, castling, enPassant, halfmove, fullmove] = parts;
  const board = placement.split("/").map((rowStr) => {
    const row = [];
    for (const ch of rowStr) {
      if (/[1-8]/.test(ch)) {
        for (let i = 0; i < Number(ch); i++) row.push(null);
      } else {
        row.push({ type: ch.toLowerCase(), color: ch === ch.toUpperCase() ? "w" : "b" });
      }
    }
    return row;
  });

  const gameState = {
    turn: turn === "b" ? "b" : "w",
    castling: {
      wK: castling.includes("K"),
      wQ: castling.includes("Q"),
      bK: castling.includes("k"),
      bQ: castling.includes("q"),
    },
    enPassant: enPassant && enPassant !== "-" ? algebraicToSquare(enPassant) : null,
    halfmove: Number(halfmove) || 0,
    fullmove: Number(fullmove) || 1,
  };
  return { board, gameState };
}

// Re-derive the captured-piece trays from board state alone (counts pieces
// missing relative to a standard set). Simpler and safer than diffing moves,
// and handles en-passant / promotions / reconnects for free.
const STANDARD_COUNTS = { p: 8, n: 2, b: 2, r: 2, q: 1 };
function deriveCapturedPieces(board) {
  const present = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const row of board) {
    for (const piece of row) {
      if (piece && piece.type !== "k") present[piece.color][piece.type]++;
    }
  }
  const capturedByWhite = []; // black pieces white has taken
  const capturedByBlack = []; // white pieces black has taken
  for (const type of Object.keys(STANDARD_COUNTS)) {
    const missingBlack = STANDARD_COUNTS[type] - present.b[type];
    for (let i = 0; i < missingBlack; i++) capturedByWhite.push({ type, color: "b" });
    const missingWhite = STANDARD_COUNTS[type] - present.w[type];
    for (let i = 0; i < missingWhite; i++) capturedByBlack.push({ type, color: "w" });
  }
  return { capturedByWhite, capturedByBlack };
}

// Map the backend's terminal-state vocabulary onto this app's local
// {status, winner, reason} shape used to render the "game over" modal.
function mapServerGameOver({ resultReason, winner }) {
  switch (resultReason) {
    case "checkmate":
      return { status: "checkmate", winner };
    case "stalemate":
      return { status: "stalemate" };
    case "draw":
      return { status: "draw", reason: "draw" };
    case "resignation":
      return { status: "resign", winner };
    case "abandoned":
      return { status: "resign", winner, reason: "opponent disconnected" };
    default:
      return { status: "draw", reason: "game over" };
  }
}

// SAN move history from the room doesn't carry per-move color, so derive it
// from move index (white moves on even indices).
function sanHistoryToLocal(moveHistorySan) {
  return (moveHistorySan || []).map((san, i) => ({ san, color: i % 2 === 0 ? "w" : "b" }));
}

/* ---- Vector chess pieces (bold, high-contrast, viewBox 0 0 100 100) ---- */

const PIECE_PATHS = {
  p: (
    <>
      <circle cx="50" cy="30" r="15" />
      <path d="M36,48 C33,60 27,68 24,79 C23,82 25,84 28,84 L72,84 C75,84 77,82 76,79 C73,68 67,60 64,48 Z" />
      <rect x="21" y="84" width="58" height="10" rx="3" />
    </>
  ),
  r: (
    <>
      <path d="M27,45 L27,26 L39,26 L39,34 L44,34 L44,26 L56,26 L56,34 L61,34 L61,26 L73,26 L73,45 Z" />
      <rect x="30" y="45" width="40" height="35" />
      <path d="M25,80 C25,84 27,88 33,88 L67,88 C73,88 75,84 75,80 Z" />
      <rect x="20" y="88" width="60" height="8" rx="3" />
    </>
  ),
  n: (
    <>
      <path d="M28,88 L28,70 C28,63 24,60 22,54 C19,46 21,38 27,32 C25,29 25,25 27,22 C29,19 33,19 35,22 C39,16 46,12 55,13 C68,15 76,25 77,37 C77,42 75,46 70,48 L73,52 C74,54 73,57 70,57 L64,55 L60,60 C65,64 67,70 67,76 L67,88 Z" />
      <rect x="24" y="88" width="47" height="7" rx="3" />
      <circle cx="41" cy="30" r="3.4" className="cx-piece-eye" />
    </>
  ),
  b: (
    <>
      <circle cx="50" cy="20" r="7" />
      <path d="M50,29 C39,38 33,52 37,68 C39,77 43,82 50,84 C57,82 61,77 63,68 C67,52 61,38 50,29 Z" />
      <rect x="43" y="46" width="14" height="4" rx="2" transform="rotate(-35 50 48)" />
      <path d="M28,84 C28,88 31,92 38,92 L62,92 C69,92 72,88 72,84 Z" />
      <rect x="22" y="92" width="56" height="7" rx="3" />
    </>
  ),
  q: (
    <>
      <circle cx="26" cy="26" r="6.5" />
      <circle cx="50" cy="18" r="7" />
      <circle cx="74" cy="26" r="6.5" />
      <circle cx="38" cy="22" r="5.5" />
      <circle cx="62" cy="22" r="5.5" />
      <path d="M26,30 L38,26 L50,32 L62,26 L74,30 L69,50 L31,50 Z" />
      <path d="M31,50 C27,62 33,68 30,80 C29,84 31,88 36,88 L64,88 C69,88 71,84 70,80 C67,68 73,62 69,50 Z" />
      <rect x="23" y="88" width="54" height="8" rx="3" />
    </>
  ),
  k: (
    <>
      <rect x="46.5" y="8" width="7" height="20" rx="2" />
      <rect x="38" y="15" width="24" height="7" rx="2" />
      <path d="M30,32 L70,32 L65,50 L35,50 Z" />
      <path d="M35,50 C30,62 37,68 33,80 C32,84 34,88 39,88 L61,88 C66,88 68,84 67,80 C63,68 70,62 65,50 Z" />
      <rect x="22" y="88" width="56" height="8" rx="3" />
    </>
  ),
};

function PieceIcon({ type, color, size = 40, className = "" }) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={`cx-piece-svg ${color === "w" ? "white" : "black"} ${className}`}
      style={{ overflow: "visible" }}
    >
      <ellipse cx="50" cy="93" rx="30" ry="5" className="cx-piece-groundshadow" />
      <g className="cx-piece-shape">{PIECE_PATHS[type]}</g>
    </svg>
  );
}

/* =========================================================================
   MAIN COMPONENT
   ========================================================================= */

export default function ChessApp() {
  const [board, setBoard] = useState(initialBoard);
  const [gameState, setGameState] = useState(initialState);
  const [mode, setMode] = useState("ai"); // 'ai' | 'human'
  const [playerColor, setPlayerColor] = useState("w");
  const [difficulty, setDifficulty] = useState("medium");
  const [selected, setSelected] = useState(null);
  const [lastMove, setLastMove] = useState(null);
  const [history, setHistory] = useState([]); // {san, color}
  const [snapshots, setSnapshots] = useState([]); // stack for undo
  const [capturedByWhite, setCapturedByWhite] = useState([]); // black pieces white has taken
  const [capturedByBlack, setCapturedByBlack] = useState([]);
  const [aiThinking, setAiThinking] = useState(false);
  const [hint, setHint] = useState(null);
  const [hintLoading, setHintLoading] = useState(false);
  const [gameOver, setGameOver] = useState(null);
  const [pendingPromotion, setPendingPromotion] = useState(null); // {from,to,color,options:[moves]}
  const [dragOverSq, setDragOverSq] = useState(null);
  const boardRef = useRef(null);

  // Online play — backed by the Django/Channels backend (see src/api.js)
  const [onlineInfo, setOnlineInfo] = useState(null); // {code, myColor, role, token, guestJoined}
  const [onlineStatus, setOnlineStatus] = useState("idle"); // idle | creating | joining | matching | connected
  const [onlineError, setOnlineError] = useState("");
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [codeCopied, setCodeCopied] = useState(false);
  const [opponentConnected, setOpponentConnected] = useState(false);
  const onlineRef = useRef(null); // mirrors onlineInfo for use inside socket callbacks/closures
  const historyCountRef = useRef(0);
  const wsRef = useRef(null); // live WebSocket connection to /ws/game/<code>/
  // Mirrors of frequently-changing state, kept fresh for use inside the
  // WebSocket's onmessage closure (which is only set up once per connection).
  const boardStateRef = useRef(board);
  const historyRef = useRef(history);
  useEffect(() => { boardStateRef.current = board; }, [board]);
  useEffect(() => { historyRef.current = history; }, [history]);

  const status = getGameStatus(board, gameState);
  const legalMoves = status.moves || [];
  const inCheck = status.status === "check" || status.status === "checkmate";
  const kingSq = inCheck ? findKing(board, gameState.turn) : null;
  const evalScore = evaluateBoard(board);
  const aiColor = playerColor === "w" ? "b" : "w";
  const isPlayersTurn =
    mode === "human" ||
    (mode === "ai" && gameState.turn === playerColor) ||
    (mode === "online" && !!onlineInfo && onlineInfo.guestJoined && gameState.turn === onlineInfo.myColor);

  useEffect(() => {
    if (status.status === "checkmate" || status.status === "stalemate" || status.status === "draw") {
      if (!gameOver) {
        setGameOver({
          status: status.status,
          winner: status.winner,
          reason: status.reason,
        });
      }
    }
  }, [board, gameState]); // eslint-disable-line

  // AI move trigger
  useEffect(() => {
    if (mode !== "ai" || gameOver) return;
    if (gameState.turn !== aiColor) return;
    setAiThinking(true);
    const timer = setTimeout(() => {
      const depth = DIFFICULTY_DEPTH[difficulty];
      const randomize = difficulty === "easy";
      const move = findBestMove(board, gameState, depth, randomize);
      setAiThinking(false);
      if (move) commitMove(move);
    }, 320);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState.turn, mode, gameOver, board]);

  // Apply the authoritative room snapshot sent right after the socket opens
  // (covers fresh rooms, reconnects, and joining a room mid-game).
  function applyServerState(data) {
    const { board: nb, gameState: ns } = boardStateFromFEN(data.fen);
    const { capturedByWhite: cw, capturedByBlack: cb } = deriveCapturedPieces(nb);
    setBoard(nb);
    setGameState(ns);
    setHistory(sanHistoryToLocal(data.moveHistory));
    setCapturedByWhite(cw);
    setCapturedByBlack(cb);
    setLastMove(null);
    setSelected(null);
    setHint(null);
    historyCountRef.current = (data.moveHistory || []).length;
    setOpponentConnected(
      onlineRef.current?.myColor === data.hostColor ? data.guestConnected : data.hostConnected
    );
    if (onlineRef.current) {
      onlineRef.current = { ...onlineRef.current, guestJoined: data.guestJoined };
      setOnlineInfo((prev) => (prev ? { ...prev, guestJoined: data.guestJoined } : prev));
    }
    setGameOver(data.status === "finished" ? mapServerGameOver(data) : null);
  }

  // Apply a single authoritative move broadcast (from either player,
  // including echoes of our own move) by rebuilding state from the FEN the
  // server returns — the server (python-chess) is always right.
  function applyServerMove(data) {
    const { board: nb, gameState: ns } = boardStateFromFEN(data.fen);
    const movingColor = ns.turn === "w" ? "b" : "w"; // side that just moved
    const { capturedByWhite: cw, capturedByBlack: cb } = deriveCapturedPieces(nb);
    const newHistory = [...historyRef.current, { san: data.san, color: movingColor }];
    setBoard(nb);
    setGameState(ns);
    setCapturedByWhite(cw);
    setCapturedByBlack(cb);
    setLastMove({ from: algebraicToSquare(data.uci.slice(0, 2)), to: algebraicToSquare(data.uci.slice(2, 4)) });
    setHistory(newHistory);
    historyCountRef.current = newHistory.length;
    setSelected(null);
    setHint(null);
    if (data.status === "finished") setGameOver(mapServerGameOver(data));
  }

  function closeOnlineSocket() {
    if (wsRef.current) {
      try { wsRef.current.onclose = null; wsRef.current.close(); } catch (e) { /* ignore */ }
      wsRef.current = null;
    }
  }

  // Open the live game WebSocket for the current room. Called right after
  // create/join/quick-match succeed, using the token that action returned.
  function connectOnlineSocket(code, token) {
    closeOnlineSocket();
    setOnlineError("");
    let ws;
    try {
      ws = new WebSocket(wsUrlForRoom(code, token));
    } catch (e) {
      setOnlineError("Couldn't open a connection to the game server.");
      return;
    }
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      let data;
      try { data = JSON.parse(evt.data); } catch (e) { return; }
      switch (data.type) {
        case "state":
          applyServerState(data);
          break;
        case "move":
          applyServerMove(data);
          break;
        case "presence":
          if (onlineRef.current && data.color !== onlineRef.current.myColor) {
            setOpponentConnected(!!data.connected);
          }
          if (typeof data.guestJoined === "boolean" && onlineRef.current && !onlineRef.current.guestJoined) {
            onlineRef.current = { ...onlineRef.current, guestJoined: data.guestJoined };
            setOnlineInfo((prev) => (prev ? { ...prev, guestJoined: data.guestJoined } : prev));
          }
          break;
        case "game_over":
          setGameOver(mapServerGameOver(data));
          break;
        case "rematch_offer":
          setOnlineError(`${data.color === "w" ? "White" : "Black"} offered a rematch — start a new room to play again.`);
          break;
        case "error":
          setOnlineError(data.message || "Something went wrong.");
          setTimeout(() => setOnlineError(""), 3500);
          break;
        default:
          break;
      }
    };

    ws.onclose = (evt) => {
      if (wsRef.current !== ws) return; // superseded by a newer connection
      wsRef.current = null;
      if (evt.code === 4404) setOnlineError("That room no longer exists.");
      else if (evt.code === 4401) setOnlineError("Couldn't authenticate you for that room.");
      else if (onlineRef.current) setOnlineError("Disconnected from the game server — reconnecting may be needed.");
    };

    ws.onerror = () => {
      setOnlineError("Connection error talking to the game server.");
    };
  }

  // Tear down the socket if we leave online mode or unmount.
  useEffect(() => {
    if (mode !== "online") closeOnlineSocket();
    return () => { if (mode !== "online") closeOnlineSocket(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  useEffect(() => () => closeOnlineSocket(), []);

  function pushSnapshot() {
    setSnapshots((s) => [...s, { board: cloneBoard(board), gameState: { ...gameState }, history: [...history], capturedByWhite: [...capturedByWhite], capturedByBlack: [...capturedByBlack] }]);
  }

  // Send a move to the authoritative backend and wait for the "move"
  // broadcast (which echoes back to the sender too) before applying it —
  // this keeps a single source of truth and can never desync from the
  // server's python-chess validation.
  function submitOnlineMove(move) {
    const uci = squareToAlgebraic(move.from) + squareToAlgebraic(move.to) + (move.promotion || "");
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setOnlineError("Not connected to the game server yet.");
      return;
    }
    ws.send(JSON.stringify({ action: "move", uci }));
    setSelected(null);
  }

  function commitMove(move) {
    if (mode === "online") {
      submitOnlineMove(move);
      return;
    }
    pushSnapshot();
    const movingColor = move.piece.color;
    const { board: nb, state: ns } = applyMove(board, gameState, move);
    const nextStatus = getGameStatus(nb, ns);
    const nowCheck = nextStatus.status === "check" || nextStatus.status === "checkmate";
    const nowMate = nextStatus.status === "checkmate";
    const san = moveToSAN(board, move, legalMoves, nowCheck, nowMate);

    if (move.captured) {
      if (movingColor === "w") setCapturedByWhite([...capturedByWhite, move.captured]);
      else setCapturedByBlack([...capturedByBlack, move.captured]);
    }
    const newHistory = [...history, { san, color: movingColor }];
    const newLastMove = { from: move.from, to: move.to };

    setBoard(nb);
    setGameState(ns);
    setLastMove(newLastMove);
    setHistory(newHistory);
    setSelected(null);
    setHint(null);
    historyCountRef.current = newHistory.length;
  }

  function attemptMove(from, to) {
    if (gameOver) return;
    if (!isPlayersTurn) return;
    const candidates = legalMoves.filter(
      (m) => m.from.r === from.r && m.from.c === from.c && m.to.r === to.r && m.to.c === to.c
    );
    if (candidates.length === 0) return false;
    if (candidates.length > 1) {
      // promotion choice needed
      setPendingPromotion({ from, to, color: candidates[0].piece.color, options: candidates });
      return true;
    }
    commitMove(candidates[0]);
    return true;
  }

  function handleSquareClick(r, c) {
    if (gameOver || pendingPromotion) return;
    if (!isPlayersTurn) return;
    const piece = board[r][c];
    if (selected) {
      if (selected.r === r && selected.c === c) {
        setSelected(null);
        return;
      }
      const moved = attemptMove(selected, { r, c });
      if (moved) return;
      if (piece && piece.color === gameState.turn) {
        setSelected({ r, c });
      } else {
        setSelected(null);
      }
      return;
    }
    if (piece && piece.color === gameState.turn) setSelected({ r, c });
  }

  function handleDragStart(e, r, c) {
    if (gameOver || pendingPromotion || !isPlayersTurn) { e.preventDefault(); return; }
    const piece = board[r][c];
    if (!piece || piece.color !== gameState.turn) { e.preventDefault(); return; }
    setSelected({ r, c });
    e.dataTransfer.setData("text/plain", `${r},${c}`);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDrop(e, r, c) {
    e.preventDefault();
    setDragOverSq(null);
    const data = e.dataTransfer.getData("text/plain");
    if (!data) return;
    const [fr, fc] = data.split(",").map(Number);
    attemptMove({ r: fr, c: fc }, { r, c });
  }

  function choosePromotion(pieceType) {
    if (!pendingPromotion) return;
    const move = pendingPromotion.options.find((m) => m.promotion === pieceType);
    setPendingPromotion(null);
    if (move) commitMove(move);
  }

  function handleUndo() {
    if (mode === "online") return; // undo would desync the two players
    if (snapshots.length === 0 || aiThinking) return;
    let target = snapshots[snapshots.length - 1];
    let newStack = snapshots.slice(0, -1);
    // if playing vs AI, undo the AI move too so it's the player's turn again
    if (mode === "ai" && newStack.length > 0 && target.gameState.turn === aiColor) {
      target = newStack[newStack.length - 1];
      newStack = newStack.slice(0, -1);
    }
    setBoard(target.board);
    setGameState(target.gameState);
    setHistory(target.history);
    setCapturedByWhite(target.capturedByWhite);
    setCapturedByBlack(target.capturedByBlack);
    setSnapshots(newStack);
    setSelected(null);
    setHint(null);
    setLastMove(null);
    setGameOver(null);
  }

  function handleNewGame(newPlayerColor) {
    setBoard(initialBoard());
    setGameState(initialState());
    setSelected(null);
    setLastMove(null);
    setHistory([]);
    setSnapshots([]);
    setCapturedByWhite([]);
    setCapturedByBlack([]);
    setAiThinking(false);
    setHint(null);
    setGameOver(null);
    setPendingPromotion(null);
    historyCountRef.current = 0;
    if (newPlayerColor) setPlayerColor(newPlayerColor);
  }

  function handleResign() {
    if (gameOver) return;
    if (mode === "online") {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: "resign" }));
      } else {
        setOnlineError("Not connected to the game server.");
      }
      return; // the server's "game_over" broadcast will set gameOver for both players
    }
    const winner = mode === "ai" ? aiColor : gameState.turn === "w" ? "b" : "w";
    setGameOver({ status: "resign", winner });
  }

  function beginOnlineSession(roomInfo) {
    // roomInfo: {code, token, color, status} — as returned by create/join/quick-match
    handleNewGame();
    setPlayerColor(roomInfo.color);
    onlineRef.current = {
      code: roomInfo.code,
      token: roomInfo.token,
      myColor: roomInfo.color,
      role: roomInfo.role || "player",
      guestJoined: roomInfo.status === "active",
    };
    setOnlineInfo({ ...onlineRef.current });
    setOpponentConnected(false);
    connectOnlineSocket(roomInfo.code, roomInfo.token);
    setOnlineStatus("connected");
  }

  async function handleCreateRoom() {
    setOnlineError("");
    setOnlineStatus("creating");
    try {
      const room = await createRoom("w");
      beginOnlineSession({ ...room, role: "host" });
    } catch (e) {
      setOnlineError(e.message || "Couldn't create a room. Please try again.");
      setOnlineStatus("idle");
    }
  }

  async function handleJoinRoom() {
    const code = joinCodeInput.trim().toUpperCase();
    if (!code) return;
    setOnlineError("");
    setOnlineStatus("joining");
    try {
      const room = await joinRoom(code);
      beginOnlineSession({ ...room, role: "guest" });
    } catch (e) {
      setOnlineError(e.message || "No room found with that code.");
      setOnlineStatus("idle");
    }
  }

  async function handleQuickMatch() {
    setOnlineError("");
    setOnlineStatus("matching");
    try {
      const room = await quickMatch();
      beginOnlineSession({ ...room, role: room.matched ? "guest" : "host" });
    } catch (e) {
      setOnlineError(e.message || "Couldn't find or open a match. Please try again.");
      setOnlineStatus("idle");
    }
  }

  function handleLeaveRoom() {
    closeOnlineSocket();
    onlineRef.current = null;
    setOnlineInfo(null);
    setOnlineStatus("idle");
    setOnlineError("");
    setJoinCodeInput("");
    setOpponentConnected(false);
    handleNewGame();
  }

  function handleCopyCode() {
    if (!onlineInfo) return;
    try {
      navigator.clipboard.writeText(onlineInfo.code);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1500);
    } catch (e) {
      /* clipboard unavailable, ignore */
    }
  }

  function handleHint() {
    if (gameOver || hintLoading || !isPlayersTurn) return;
    setHintLoading(true);
    setTimeout(() => {
      const move = findBestMove(board, gameState, Math.min(3, DIFFICULTY_DEPTH[difficulty] + 1), false);
      setHint(move ? { from: move.from, to: move.to } : null);
      setHintLoading(false);
    }, 50);
  }

  const targets = selected ? movesFrom(legalMoves, selected.r, selected.c) : [];
  const targetSet = new Set(targets.map((m) => `${m.to.r},${m.to.c}`));

  const evalClamped = Math.max(-800, Math.min(800, evalScore));
  const evalPct = 50 + (evalClamped / 800) * 50; // 0..100, white share from bottom

  const flipped =
    (mode === "ai" && playerColor === "b") ||
    (mode === "online" && onlineInfo && onlineInfo.myColor === "b");
  const displayRows = flipped ? [...Array(8).keys()].reverse() : [...Array(8).keys()];
  const displayCols = flipped ? [...Array(8).keys()].reverse() : [...Array(8).keys()];

  const resultText = (() => {
    if (!gameOver) return "";
    if (gameOver.status === "checkmate") {
      const winnerName = gameOver.winner === "w" ? "White" : "Black";
      return `Checkmate — ${winnerName} wins`;
    }
    if (gameOver.status === "stalemate") return "Stalemate — draw";
    if (gameOver.status === "draw") return `Draw — ${gameOver.reason}`;
    if (gameOver.status === "resign") {
      const winnerName = gameOver.winner === "w" ? "White" : gameOver.winner === "b" ? "Black" : null;
      if (gameOver.reason === "opponent disconnected") {
        return winnerName ? `${winnerName} wins — opponent disconnected` : "Game abandoned";
      }
      return winnerName ? `${winnerName} wins by resignation` : "Game over";
    }
    return "";
  })();

  return (
    <div className="cx-root">
      <style>{`
        .cx-root {
          --bg: #15100e;
          --panel: #1d1613;
          --panel-border: #35271f;
          --sq-light: #ecd9ce;
          --sq-dark: #7a2333;
          --sq-dark-deep: #591a26;
          --accent: #e2543a;
          --accent-soft: rgba(226,84,58,0.35);
          --text: #f3e9e0;
          --text-muted: #b39c8d;
          --gold: #d8a657;
          --piece-white-fill: #fbf3ea;
          --piece-white-stroke: #3a2a22;
          --piece-black-fill: #201512;
          --piece-black-stroke: #e7c9b8;
          --font-display: 'Fraunces', Georgia, serif;
          --font-body: 'Manrope', -apple-system, sans-serif;
          background: radial-gradient(ellipse at top, #241a16 0%, var(--bg) 60%);
          color: var(--text);
          font-family: var(--font-body);
          min-height: 100%;
          padding: 24px 16px 40px;
        }
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Manrope:wght@400;500;600;700;800&display=swap');
        .cx-title { font-family: var(--font-display); letter-spacing: -0.01em; }
        .cx-wrap { max-width: 980px; margin: 0 auto; }
        .cx-layout { display: flex; gap: 22px; align-items: flex-start; flex-wrap: wrap; justify-content: center; }
        .cx-board-col { display: flex; gap: 12px; align-items: stretch; }
        .cx-board-outer {
          width: min(88vw, 520px);
          aspect-ratio: 1;
          border-radius: 10px;
          overflow: hidden;
          box-shadow: 0 20px 50px -12px rgba(0,0,0,0.65), 0 0 0 1px var(--panel-border);
          position: relative;
        }
        .cx-board { display: grid; grid-template-columns: repeat(8, 1fr); grid-template-rows: repeat(8, 1fr); width: 100%; height: 100%; }
        .cx-board-overlay {
          position: absolute; inset: 0; background: rgba(10,7,6,0.72); display: flex;
          flex-direction: column; align-items: center; justify-content: center; gap: 10px;
          color: var(--text); font-size: 13px; font-weight: 600; text-align: center; padding: 20px;
          border-radius: 10px;
        }
        .cx-sq { position: relative; display: flex; align-items: center; justify-content: center; }
        .cx-sq.light { background: var(--sq-light); }
        .cx-sq.dark { background: linear-gradient(160deg, var(--sq-dark), var(--sq-dark-deep)); }
        .cx-sq.selected { box-shadow: inset 0 0 0 3px var(--gold); }
        .cx-sq.last { background-blend-mode: multiply; }
        .cx-sq.last.light { background: #e3c9a8; }
        .cx-sq.last.dark { background: linear-gradient(160deg, #8a3040, #642133); }
        .cx-sq.hint { box-shadow: inset 0 0 0 3px #5fd0a8; }
        .cx-sq.check-king { box-shadow: inset 0 0 0 3px #ff3b30; animation: cx-pulse 1s ease-in-out infinite; }
        @keyframes cx-pulse { 0%,100% { box-shadow: inset 0 0 0 3px #ff3b30; } 50% { box-shadow: inset 0 0 0 5px #ff7a6e; } }
        .cx-dot { width: 26%; height: 26%; border-radius: 50%; background: rgba(20,15,12,0.35); pointer-events: none; }
        .cx-sq.light .cx-dot { background: rgba(60,30,30,0.28); }
        .cx-ring { position: absolute; inset: 6%; border-radius: 8px; box-shadow: inset 0 0 0 4px rgba(20,15,12,0.35); pointer-events: none; }
        .cx-coord { position: absolute; font-size: 9px; font-weight: 700; opacity: 0.55; font-family: var(--font-body); }
        .cx-coord.file { bottom: 2px; right: 4px; }
        .cx-coord.rank { top: 2px; left: 4px; }
        .cx-sq.light .cx-coord { color: var(--sq-dark); }
        .cx-sq.dark .cx-coord { color: var(--sq-light); }
        .cx-piece-svg {
          width: clamp(34px, 8.4vw, 58px);
          height: clamp(34px, 8.4vw, 58px);
          user-select: none;
          cursor: grab;
          transition: transform 0.12s ease;
          filter: drop-shadow(0 4px 3px rgba(0,0,0,0.5));
          position: relative; z-index: 2;
        }
        .cx-piece-svg:active { cursor: grabbing; }
        .cx-piece-svg:hover { transform: scale(1.1) translateY(-1px); }
        .cx-piece-svg.tiny { width: 22px; height: 22px; filter: none; cursor: default; }
        .cx-piece-svg.tiny:hover { transform: none; }
        .cx-piece-groundshadow { fill: rgba(0,0,0,0.28); }
        .cx-piece-svg.white .cx-piece-shape path,
        .cx-piece-svg.white .cx-piece-shape rect,
        .cx-piece-svg.white .cx-piece-shape circle {
          fill: var(--piece-white-fill);
          stroke: var(--piece-white-stroke);
          stroke-width: 2.75;
          stroke-linejoin: round;
        }
        .cx-piece-svg.black .cx-piece-shape path,
        .cx-piece-svg.black .cx-piece-shape rect,
        .cx-piece-svg.black .cx-piece-shape circle {
          fill: var(--piece-black-fill);
          stroke: var(--piece-black-stroke);
          stroke-width: 2.25;
          stroke-linejoin: round;
        }
        .cx-piece-svg .cx-piece-eye { stroke-width: 0 !important; }
        .cx-piece-svg.white .cx-piece-eye { fill: var(--piece-white-stroke) !important; }
        .cx-piece-svg.black .cx-piece-eye { fill: var(--piece-black-stroke) !important; }
        .cx-eval { width: 20px; border-radius: 6px; overflow: hidden; box-shadow: inset 0 0 0 1px var(--panel-border); display: flex; flex-direction: column-reverse; background: #241715; }
        .cx-eval-fill { background: linear-gradient(180deg, #fbf3ea, #e7d9c8); transition: height 0.4s ease; }
        .cx-panel { width: min(88vw, 300px); background: var(--panel); border: 1px solid var(--panel-border); border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
        .cx-btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
        .cx-btn {
          font-family: var(--font-body); font-weight: 600; font-size: 13px;
          background: #2a1e19; color: var(--text); border: 1px solid var(--panel-border);
          padding: 8px 12px; border-radius: 8px; cursor: pointer; transition: all 0.15s;
          display: flex; align-items: center; gap: 6px;
        }
        .cx-btn:hover { background: #3a2822; border-color: var(--accent); }
        .cx-btn.active { background: var(--accent); border-color: var(--accent); color: #fff5f0; }
        .cx-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .cx-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); font-weight: 700; }
        .cx-captured { display: flex; flex-wrap: wrap; gap: 2px; min-height: 22px; font-size: 20px; }
        .cx-movelist { max-height: 220px; overflow-y: auto; font-size: 13px; display: grid; grid-template-columns: auto 1fr 1fr; gap: 4px 8px; }
        .cx-movelist .num { color: var(--text-muted); }
        .cx-status-pill {
          font-size: 12px; font-weight: 700; padding: 5px 10px; border-radius: 999px;
          background: var(--accent-soft); color: #ffb8a3; display: inline-flex; align-items: center; gap: 6px; width: fit-content;
        }
        .cx-overlay { position: fixed; inset: 0; background: rgba(10,7,6,0.72); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 16px; }
        .cx-modal { background: var(--panel); border: 1px solid var(--panel-border); border-radius: 16px; padding: 24px; max-width: 340px; width: 100%; text-align: center; }
        .cx-promo-row { display: flex; gap: 10px; justify-content: center; margin-top: 14px; }
        .cx-promo-btn { background: #2a1e19; border: 1px solid var(--panel-border); border-radius: 10px; width: 64px; height: 64px; cursor: pointer; display:flex; align-items:center; justify-content:center; }
        .cx-promo-btn:hover { border-color: var(--gold); background: #3a2822; }
        .cx-thinking { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
        .cx-dotpulse { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: cx-dp 1s infinite ease-in-out; }
        @keyframes cx-dp { 0%,80%,100% { opacity: 0.3; } 40% { opacity: 1; } }
      `}</style>

      <div className="cx-wrap">
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 8 }}>
         <div className="cx-brand">
  <span className="cx-brand-mark">♞</span>
  <div className="cx-brand-text">
    <h1 className="cx-title">Satranj Ka Khel</h1>
    <span className="cx-subtitle">शतरंज का खेल</span>
  </div>
</div>
<div className="cx-thinking" style={{ minHeight: 16 }}>
  {aiThinking && (<><span className="cx-dotpulse" /><span>Engine is thinking…</span></>)}
</div>
</div>

        <div className="cx-layout">
          <div className="cx-board-col">
            <div className="cx-eval" aria-label="Evaluation bar">
              <div className="cx-eval-fill" style={{ height: `${evalPct}%` }} />
            </div>
            <div className="cx-board-outer">
              <div className="cx-board" ref={boardRef}>
                {displayRows.map((r) =>
                  displayCols.map((c) => {
                    const piece = board[r][c];
                    const isLight = (r + c) % 2 === 0;
                    const isSelected = selected && selected.r === r && selected.c === c;
                    const isLast = lastMove && ((lastMove.from.r === r && lastMove.from.c === c) || (lastMove.to.r === r && lastMove.to.c === c));
                    const isTarget = targetSet.has(`${r},${c}`);
                    const isCheckKing = inCheck && kingSq && kingSq.r === r && kingSq.c === c;
                    const isHint = hint && ((hint.from.r === r && hint.from.c === c) || (hint.to.r === r && hint.to.c === c));
                    const showFileCoord = r === (flipped ? 0 : 7);
                    const showRankCoord = c === (flipped ? 7 : 0);
                    return (
                      <div
                        key={`${r}-${c}`}
                        className={[
                          "cx-sq",
                          isLight ? "light" : "dark",
                          isSelected ? "selected" : "",
                          isLast ? "last" : "",
                          isCheckKing ? "check-king" : "",
                          isHint ? "hint" : "",
                        ].join(" ").trim()}
                        onClick={() => handleSquareClick(r, c)}
                        onDragOver={(e) => { e.preventDefault(); setDragOverSq(`${r},${c}`); }}
                        onDrop={(e) => handleDrop(e, r, c)}
                      >
                        {showFileCoord && <span className="cx-coord file">{FILES[c]}</span>}
                        {showRankCoord && <span className="cx-coord rank">{8 - r}</span>}
                        {isTarget && (piece ? <div className="cx-ring" /> : <div className="cx-dot" />)}
                        {piece && (
                          <span
                            draggable={isPlayersTurn && piece.color === gameState.turn}
                            onDragStart={(e) => handleDragStart(e, r, c)}
                            title={`${piece.color === "w" ? "White" : "Black"} ${PIECE_NAME[piece.type]}`}
                            style={{ display: "flex" }}
                          >
                            <PieceIcon type={piece.type} color={piece.color} />
                          </span>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
              {mode === "online" && (!onlineInfo || !onlineInfo.guestJoined) && (
                <div className="cx-board-overlay">
                  <Globe size={22} />
                  <span>{onlineInfo ? "Waiting for your opponent to join…" : "Create or join a room to start"}</span>
                </div>
              )}
            </div>
          </div>

          <div className="cx-panel">
            <div>
              <div className="cx-label" style={{ marginBottom: 6 }}>Mode</div>
              <div className="cx-btn-row">
                <button className={`cx-btn ${mode === "ai" ? "active" : ""}`} onClick={() => { setMode("ai"); onlineRef.current = null; setOnlineInfo(null); handleNewGame(); }}>
                  <Cpu size={14} /> Vs Engine
                </button>
                <button className={`cx-btn ${mode === "human" ? "active" : ""}`} onClick={() => { setMode("human"); onlineRef.current = null; setOnlineInfo(null); handleNewGame(); }}>
                  <Users size={14} /> Two Player
                </button>
                <button className={`cx-btn ${mode === "online" ? "active" : ""}`} onClick={() => { setMode("online"); handleNewGame(); }}>
                  <Globe size={14} /> Play Online
                </button>
              </div>
            </div>

            {mode === "online" && !onlineInfo && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div className="cx-label">Play online</div>
                <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
                  Get matched instantly, create a private room and send the code to a friend, or join theirs. Moves sync live over a WebSocket.
                </p>
                <button className="cx-btn active" onClick={handleQuickMatch} disabled={onlineStatus === "matching"}>
                  <Globe size={14} /> {onlineStatus === "matching" ? "Finding opponent…" : "Quick Match"}
                </button>
                <button className="cx-btn" onClick={handleCreateRoom} disabled={onlineStatus === "creating"}>
                  <Globe size={14} /> {onlineStatus === "creating" ? "Creating…" : "Create Private Room"}
                </button>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    value={joinCodeInput}
                    onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                    placeholder="Enter code"
                    maxLength={5}
                    style={{
                      flex: 1, background: "#2a1e19", border: "1px solid var(--panel-border)", borderRadius: 8,
                      color: "var(--text)", padding: "8px 10px", fontFamily: "var(--font-body)", fontWeight: 700,
                      letterSpacing: "0.1em", textTransform: "uppercase", fontSize: 13,
                    }}
                  />
                  <button className="cx-btn" onClick={handleJoinRoom} disabled={onlineStatus === "joining" || !joinCodeInput.trim()}>
                    {onlineStatus === "joining" ? "Joining…" : "Join"}
                  </button>
                </div>
                {onlineError && <div style={{ color: "#ff8a75", fontSize: 12 }}>{onlineError}</div>}
              </div>
            )}

            {mode === "online" && onlineInfo && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div className="cx-label">Room code</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ fontFamily: "var(--font-display)", fontSize: 26, letterSpacing: "0.12em", fontWeight: 700, color: "var(--gold)" }}>
                    {onlineInfo.code}
                  </div>
                  <button className="cx-btn" onClick={handleCopyCode} title="Copy code">
                    {codeCopied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
                <div className="cx-thinking">
                  {!onlineInfo.guestJoined ? (
                    <><span className="cx-dotpulse" /><span>Waiting for opponent to join…</span></>
                  ) : opponentConnected ? (
                    <span style={{ color: "#5fd0a8", fontWeight: 700 }}>● Connected — you're playing {onlineInfo.myColor === "w" ? "White" : "Black"}</span>
                  ) : (
                    <><span className="cx-dotpulse" /><span>Opponent disconnected — waiting for them to reconnect…</span></>
                  )}
                </div>
                {onlineError && <div style={{ color: "#ff8a75", fontSize: 12 }}>{onlineError}</div>}
                <button className="cx-btn" onClick={handleLeaveRoom}><LogOut size={14} /> Leave Room</button>
              </div>
            )}

            {mode === "ai" && (
              <div>
                <div className="cx-label" style={{ marginBottom: 6 }}>Difficulty</div>
                <div className="cx-btn-row">
                  {["easy", "medium", "hard", "expert"].map((d) => (
                    <button key={d} className={`cx-btn ${difficulty === d ? "active" : ""}`} onClick={() => setDifficulty(d)}>
                      {d[0].toUpperCase() + d.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {mode === "ai" && (
              <div>
                <div className="cx-label" style={{ marginBottom: 6 }}>Play as</div>
                <div className="cx-btn-row">
                  <button className={`cx-btn ${playerColor === "w" ? "active" : ""}`} onClick={() => { setPlayerColor("w"); handleNewGame("w"); }}>White</button>
                  <button className={`cx-btn ${playerColor === "b" ? "active" : ""}`} onClick={() => { setPlayerColor("b"); handleNewGame("b"); }}>Black</button>
                </div>
              </div>
            )}

            <div>
              <div className="cx-label" style={{ marginBottom: 6 }}>Captured</div>
              <div className="cx-captured">{capturedByWhite.map((p, i) => <PieceIcon key={i} type={p.type} color="b" size={22} className="tiny" />)}</div>
              <div className="cx-captured">{capturedByBlack.map((p, i) => <PieceIcon key={i} type={p.type} color="w" size={22} className="tiny" />)}</div>
            </div>

            <div>
              <div className="cx-label" style={{ marginBottom: 6 }}>Moves</div>
              <div className="cx-movelist">
                {history.map((h, i) =>
                  i % 2 === 0 ? (
                    <React.Fragment key={i}>
                      <span className="num">{i / 2 + 1}.</span>
                      <span>{h.san}</span>
                      <span>{history[i + 1] ? history[i + 1].san : ""}</span>
                    </React.Fragment>
                  ) : null
                )}
              </div>
            </div>

            {status.status === "check" && !gameOver && (
              <div className="cx-status-pill">Check — {gameState.turn === "w" ? "White" : "Black"} to move</div>
            )}

           <div className="cx-btn-row cx-actionbar">
  <button className="cx-btn" onClick={() => handleNewGame()} disabled={mode === "online"}><RotateCcw size={14} /> <span>New Game</span></button>
  <button className="cx-btn" onClick={handleUndo} disabled={mode === "online" || snapshots.length === 0}><RotateCcw size={14} style={{ transform: "scaleX(-1)" }} /> <span>Undo</span></button>
  <button className="cx-btn" onClick={handleHint} disabled={hintLoading || !!gameOver}><Lightbulb size={14} /> <span>Hint</span></button>
  <button className="cx-btn" onClick={handleResign} disabled={!!gameOver || (mode === "online" && (!onlineInfo || !onlineInfo.guestJoined))}><Flag size={14} /> <span>Resign</span></button>
</div>
          </div>
        </div>
      </div>

      {pendingPromotion && (
        <div className="cx-overlay">
          <div className="cx-modal">
            <Crown size={28} color="var(--gold)" />
            <h3 className="cx-title" style={{ margin: "10px 0 4px", fontSize: 20 }}>Promote pawn</h3>
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>Choose a piece</p>
            <div className="cx-promo-row">
              {["q", "r", "b", "n"].map((pt) => (
                <button key={pt} className="cx-promo-btn" onClick={() => choosePromotion(pt)}>
                  <PieceIcon type={pt} color={pendingPromotion.color} size={44} />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {gameOver && (
        <div className="cx-overlay">
          <div className="cx-modal">
            <Crown size={28} color="var(--gold)" />
            <h3 className="cx-title" style={{ margin: "10px 0 6px", fontSize: 22 }}>{resultText}</h3>
            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 4px" }}>{history.length} moves played</p>
            <div className="cx-btn-row" style={{ justifyContent: "center", marginTop: 12 }}>
              <button className="cx-btn active" onClick={() => handleNewGame()}>Play again</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
