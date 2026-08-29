This document explains Partshelf's internal organization. It focuses on concepts and workflows rather than implementation details. Reading this document should provide enough understanding to navigate most of the codebase without reading individual source files.

## Core Design philosophy

Partshelf intentionally models the physical world.

Rather than treating inventory, fabrication, and purchasing as independent systems, they are simply different stages in a part's lifecycle.

A part may begin as:

an imported BOM line,
a fabricated component,
or a purchased COTS item,

but eventually all three become inventory that can be assembled into a robot.

Because of this, all major systems share common abstractions rather than duplicating information.

# Domain Model

## Categories

Categories describe families of components.

Examples include:

Bearings
Bolts
Shafts
Plates
Belts

Categories also define required attributes.

Example:
> - Bolt
> - Thread Size
> - Length
> - Head Style
> - Material

Every component belonging to the Bolt category must provide those attributes. Categories provide structure without defining individual parts.

## Components
Components describe what a part is. Components intentionally do not represent physical inventory. Instead, they describe one unique real-world part.

Example:
> - Socket Head Bolt
> - 1/4-20
> - 2"
> - Steel
> - Black Oxide

There is exactly one Component representing that bolt. Every physical copy references it. This abstraction eliminates duplicate descriptions throughout the application.

## Inventory Instances
Inventory Instances represent where parts exist. Each instance references exactly one Component.  
Example:
> Component
> ↓
> 1/4-20 × 2" Bolt
> ↓
> Inventory Instance
> 
> Location:
> Drawer C4
> 
> Quantity:
> 18

Separating Components from Inventory allows multiple storage locations for the same part.

# System responsibilities

## Inventory
Responsible for:

- Components
- Categories
- Inventory Instances
- Locations
- Searching
- Images

Inventory never concerns itself with CAD.

# Architectural Principles

## Agent-first priority
This codebase is maintained and developed mainly through artificial intelligence agents. The frontend/UI is directly interacted with by users, and should cater to users. Everything else including the code is mainly engineered by agents, and thus future code and documentation should be written for *agents* to best promote their understanding and productivity. 

## Single Source of Truth
Every piece of information should exist in exactly one place.

Inventory should never duplicate Component definitions. Assemblies should never duplicate Inventory. Fabrication should never duplicate Assembly data.

## Domain Separation
Inventory, Designer, Fabrication, Orders, and Onshape integration should remain independent. Communication should occur through well-defined interfaces rather than shared implementation.

## Workflow First

The user interface should reflect the team's real manufacturing process. Every additional click, dialog, or manual data entry should have a clear justification. If users begin maintaining parallel spreadsheets or notes, the application has failed its primary objective.

# Future Direction 
The long-term vision is to evolve Partshelf into a complete logistics platform supporting:

- Inventory

while preserving the same underlying philosophy:


