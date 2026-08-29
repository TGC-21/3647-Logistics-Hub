# Database Architecture

This document explains the conceptual database design used by Partshelf.

Unlike `schema.sql`, this document focuses on **why** the database is organized the way it is rather than how each table is implemented.

Understanding these concepts will make the remainder of the application much easier to understand.

---

# Design Goals

The database was designed around a few guiding principles.

## 1. Model the Real World

## 2. Single Source of Truth

Information should only exist in one place.

Examples:

- A bolt's dimensions should only exist once.
- Inventory locations should only exist once.
- Assembly definitions should only exist once.
- Duplicating information inevitably causes inconsistencies.

## 3. Separate "What" from "Where"

One of the most important architectural decisions is separating Components from Inventory.

A Component describes WHAT something is.

An Inventory Instance describes WHERE it exists.

Example:

Component

1/4-20 x 2" Socket Head Bolt

↓

Inventory Instance

Drawer C4

Quantity 18

↓

Inventory Instance

Pit Toolbox

Quantity 6

Both inventory locations reference the exact same Component.

This dramatically reduces duplicate data.

---

# Entity Relationship Diagram

```
                    Category
                        │
                        │
                        ▼
                  Component
                        │
                        |
                        ▼              
                Inventory Instance  

```
