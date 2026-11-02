FeatureScript 3112;
import(path : "onshape/std/common.fs", version : "3112.0");

/**
 * A PGA-style CPU package built from parameters: a substrate with a marked corner, a grid of
 * pins with an empty centre, a row of capacitors along each edge of the lid, and a heat
 * spreader (the lid) with rounded edges. Each part gets a name and a colour, so that a glTF
 * export carries them into a web viewer.
 *
 * Source of truth for the Onshape Feature Studio "CPU Package" in the CPU document. After a
 * change here, paste the whole file into that Feature Studio, then add or regenerate the
 * feature in the Part Studio and export glTF for src/gfx.
 */
annotation { "Feature Type Name" : "CPU Package",
             "Feature Type Description" : "Parametric CPU package: substrate, pin grid, capacitors, and lid." }
export const cpuPackage = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Group Name" : "Package", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Package size" }
            isLength(definition.packageSize, { (millimeter) : [10, 40, 120] } as LengthBoundSpec);
            annotation { "Name" : "Package thickness" }
            isLength(definition.packageThickness, { (millimeter) : [0.5, 1.6, 6] } as LengthBoundSpec);
            annotation { "Name" : "Corner mark width" }
            isLength(definition.cornerMark, { (millimeter) : [0, 2.5, 10] } as LengthBoundSpec);
        }
        annotation { "Group Name" : "Lid", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Lid size" }
            isLength(definition.lidSize, { (millimeter) : [5, 28, 100] } as LengthBoundSpec);
            annotation { "Name" : "Lid height" }
            isLength(definition.lidHeight, { (millimeter) : [0.5, 2.4, 10] } as LengthBoundSpec);
            annotation { "Name" : "Lid edge radius" }
            isLength(definition.lidRadius, { (millimeter) : [0, 0.5, 3] } as LengthBoundSpec);
        }
        annotation { "Group Name" : "Pins", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Pins" }
            definition.hasPins is boolean;
            if (definition.hasPins)
            {
                annotation { "Name" : "Pins per side" }
                isInteger(definition.pinsPerSide, { (unitless) : [2, 26, 60] } as IntegerBoundSpec);
                annotation { "Name" : "Empty centre, pins per side" }
                isInteger(definition.emptyCentre, { (unitless) : [0, 8, 58] } as IntegerBoundSpec);
                annotation { "Name" : "Pin pitch" }
                isLength(definition.pinPitch, { (millimeter) : [0.3, 1.27, 5] } as LengthBoundSpec);
                annotation { "Name" : "Pin diameter" }
                isLength(definition.pinDiameter, { (millimeter) : [0.1, 0.35, 2] } as LengthBoundSpec);
                annotation { "Name" : "Pin length" }
                isLength(definition.pinLength, { (millimeter) : [0.5, 3, 12] } as LengthBoundSpec);
            }
        }
        annotation { "Group Name" : "Traces", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Traces" }
            definition.hasTraces is boolean;
            if (definition.hasTraces)
            {
                annotation { "Name" : "Traces per side" }
                isInteger(definition.tracesPerSide, { (unitless) : [1, 14, 60] } as IntegerBoundSpec);
                annotation { "Name" : "Trace width" }
                isLength(definition.traceWidth, { (millimeter) : [0.05, 0.3, 2] } as LengthBoundSpec);
                annotation { "Name" : "Fan-out" }
                isLength(definition.traceFan, { (millimeter) : [0, 2.5, 10] } as LengthBoundSpec);
            }
        }
        annotation { "Group Name" : "Capacitors", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Capacitors" }
            definition.hasCapacitors is boolean;
            if (definition.hasCapacitors)
            {
                annotation { "Name" : "Capacitors per edge" }
                isInteger(definition.capsPerEdge, { (unitless) : [1, 7, 40] } as IntegerBoundSpec);
                annotation { "Name" : "Capacitor length" }
                isLength(definition.capLength, { (millimeter) : [0.3, 2, 10] } as LengthBoundSpec);
            }
        }
    }
    {
        const zero = 0 * meter;
        const half = definition.packageSize / 2;
        const thickness = definition.packageThickness;

        // --- Substrate: top face on the XY plane, body below it. --------------------------
        fCuboid(context, id + "substrate", {
                "corner1" : vector(-half, -half, -thickness),
                "corner2" : vector(half, half, zero)
        });
        if (definition.cornerMark > zero)
        {
            // A chamfer on one vertical edge marks pin 1, as on a real package.
            const verticalEdges = qParallelEdges(qCreatedBy(id + "substrate", EntityType.EDGE), vector(0, 0, 1));
            opChamfer(context, id + "cornerMark", {
                    "entities" : qClosestTo(verticalEdges, vector(-half, -half, zero)),
                    "chamferType" : ChamferType.EQUAL_OFFSETS,
                    "width" : definition.cornerMark
            });
        }
        namePart(context, qCreatedBy(id + "substrate", EntityType.BODY), "Substrate", color(0.09, 0.19, 0.16));

        // --- Lid: a block on the substrate with rounded vertical and top edges. ----------
        const lidHalf = definition.lidSize / 2;
        fCuboid(context, id + "lid", {
                "corner1" : vector(-lidHalf, -lidHalf, zero),
                "corner2" : vector(lidHalf, lidHalf, definition.lidHeight)
        });
        if (definition.lidRadius > zero)
        {
            const lidEdges = qCreatedBy(id + "lid", EntityType.EDGE);
            opFillet(context, id + "lidVertical", {
                    "entities" : qParallelEdges(lidEdges, vector(0, 0, 1)),
                    "radius" : definition.lidRadius * 2
            });
            const topFace = qFarthestAlong(qCreatedBy(id + "lid", EntityType.FACE), vector(0, 0, 1));
            opFillet(context, id + "lidTop", {
                    "entities" : qAdjacent(topFace, AdjacencyType.EDGE, EntityType.EDGE),
                    "radius" : definition.lidRadius
            });
        }
        namePart(context, qCreatedBy(id + "lid", EntityType.BODY), "Lid", color(0.72, 0.75, 0.78));

        // --- Pins: one seed pin, patterned over the grid, joined by a thin carrier plate. ---
        if (definition.hasPins)
        {
            const n = definition.pinsPerSide;
            const pitch = definition.pinPitch;
            const centre = (n - 1) / 2;
            const emptyHalf = min(definition.emptyCentre, n - 2) / 2;
            const radius = definition.pinDiameter / 2;
            const carrierThickness = 0.15 * millimeter;

            // Pins overlap the carrier plate a little, so that the union makes one part.
            const pinTop = -thickness - carrierThickness / 2;
            const pinBottom = -thickness - carrierThickness - definition.pinLength;

            var seedPlaced = false;
            var seed = vector(zero, zero);
            var transforms = [];
            var names = [];
            for (var i = 0; i < n; i += 1)
            {
                for (var j = 0; j < n; j += 1)
                {
                    const gx = i - centre;
                    const gy = j - centre;
                    if (abs(gx) < emptyHalf && abs(gy) < emptyHalf)
                        continue;
                    const at = vector(gx * pitch, gy * pitch);
                    if (!seedPlaced)
                    {
                        seed = at;
                        seedPlaced = true;
                        fCylinder(context, id + "pin", {
                                "topCenter" : vector(at[0], at[1], pinTop),
                                "bottomCenter" : vector(at[0], at[1], pinBottom),
                                "radius" : radius
                        });
                    }
                    else
                    {
                        const shift = at - seed;
                        transforms = append(transforms, transform(vector(shift[0], shift[1], zero)));
                        names = append(names, "p" ~ i ~ "_" ~ j);
                    }
                }
            }
            if (size(transforms) > 0)
            {
                opPattern(context, id + "pinPattern", {
                        "entities" : qCreatedBy(id + "pin", EntityType.BODY),
                        "transforms" : transforms,
                        "instanceNames" : names
                });
            }
            const carrierHalf = (centre + 1) * pitch;
            fCuboid(context, id + "carrier", {
                    "corner1" : vector(-carrierHalf, -carrierHalf, -thickness - carrierThickness),
                    "corner2" : vector(carrierHalf, carrierHalf, -thickness)
            });
            const pinBodies = qUnion([
                        qCreatedBy(id + "carrier", EntityType.BODY),
                        qCreatedBy(id + "pin", EntityType.BODY),
                        qCreatedBy(id + "pinPattern", EntityType.BODY)
                    ]);
            opBoolean(context, id + "pinUnion", {
                    "tools" : pinBodies,
                    "operationType" : BooleanOperationType.UNION
            });
            namePart(context, pinBodies, "Pins", color(0.82, 0.66, 0.31));
        }

        // --- Traces: gold fan-out lines on the substrate, like the wiring of a real package. ---
        // A ring sits half under the lid edge. On each side, traces leave the ring outwards,
        // jog by 45 degrees so that they spread out, and end in a round pad near the package
        // edge. Every piece touches the ring, so the union gives one part.
        if (definition.hasTraces)
        {
            const w = definition.traceWidth;
            const h = 0.08 * millimeter;
            const tid = id + "traces";
            const zAxis = line(vector(zero, zero, zero), vector(0, 0, 1));

            const ringWidth = 0.6 * millimeter;
            const ringInner = lidHalf - ringWidth / 2;
            const ringOuter = lidHalf + ringWidth / 2;
            fCuboid(context, tid + "ringE", { "corner1" : vector(ringInner, -ringOuter, zero), "corner2" : vector(ringOuter, ringOuter, h) });
            fCuboid(context, tid + "ringW", { "corner1" : vector(-ringOuter, -ringOuter, zero), "corner2" : vector(-ringInner, ringOuter, h) });
            fCuboid(context, tid + "ringN", { "corner1" : vector(-ringOuter, ringInner, zero), "corner2" : vector(ringOuter, ringOuter, h) });
            fCuboid(context, tid + "ringS", { "corner1" : vector(-ringOuter, -ringOuter, zero), "corner2" : vector(ringOuter, -ringInner, h) });

            const count = definition.tracesPerSide;
            const fan = definition.traceFan;
            const uStart = ringOuter - w;                   // overlaps the ring
            const uBend = ringOuter + 0.8 * millimeter;     // where the jog starts
            const uEnd = half - 1.5 * millimeter;           // pad centre
            const vSpan = lidHalf * 0.8;                    // lateral spread at the ring
            const padRadius = w * 1.5;

            // Each side is built along +X (u outwards, v sideways), then turned into place.
            for (var side = 0; side < 4; side += 1)
            {
                const sideId = tid + ("side" ~ side);
                for (var k = 0; k < count; k += 1)
                {
                    const f = count == 1 ? 0 : (k / (count - 1)) * 2 - 1;   // -1 .. 1 along the side
                    const v0 = f * vSpan;
                    const jog = f * fan;
                    const v1 = v0 + jog;
                    const uAfter = uBend + abs(jog);
                    const kId = sideId + ("t" ~ k);

                    // Ring to bend.
                    fCuboid(context, kId + "a", {
                            "corner1" : vector(uStart, v0 - w / 2, zero),
                            "corner2" : vector(uBend + w / 2, v0 + w / 2, h)
                    });
                    // The 45 degree jog: a bar built at the origin, then turned and moved.
                    if (abs(jog) > w / 4)
                    {
                        const diagonal = abs(jog) * sqrt(2) + w;
                        fCuboid(context, kId + "b", {
                                "corner1" : vector(-diagonal / 2, -w / 2, zero),
                                "corner2" : vector(diagonal / 2, w / 2, h)
                        });
                        const angle = (jog > zero ? 45 : -45) * degree;
                        const centre = vector((uBend + uAfter) / 2, (v0 + v1) / 2, zero);
                        opTransform(context, kId + "bMove", {
                                "bodies" : qCreatedBy(kId + "b", EntityType.BODY),
                                "transform" : transform(centre) * rotationAround(zAxis, angle)
                        });
                    }
                    // Bend to pad.
                    fCuboid(context, kId + "c", {
                            "corner1" : vector(uAfter - w / 2, v1 - w / 2, zero),
                            "corner2" : vector(uEnd, v1 + w / 2, h)
                    });
                    fCylinder(context, kId + "pad", {
                            "topCenter" : vector(uEnd, v1, h),
                            "bottomCenter" : vector(uEnd, v1, zero),
                            "radius" : padRadius
                    });
                }
                if (side > 0)
                {
                    opTransform(context, sideId + "turn", {
                            "bodies" : qCreatedBy(sideId, EntityType.BODY),
                            "transform" : rotationAround(zAxis, side * 90 * degree)
                    });
                }
            }
            const traceBodies = qCreatedBy(tid, EntityType.BODY);
            opBoolean(context, tid + "union", {
                    "tools" : traceBodies,
                    "operationType" : BooleanOperationType.UNION
            });
            namePart(context, traceBodies, "Traces", color(0.85, 0.7, 0.35));
        }

        // --- Capacitors: a row along each edge of the lid, lying on the substrate. ---------
        if (definition.hasCapacitors)
        {
            const count = definition.capsPerEdge;
            const length = definition.capLength;
            const width = length * 0.55;
            const height = length * 0.45;
            const gap = length * 1.4;
            const spacing = length * 1.3;
            const edge = lidHalf + gap;
            const first = -((count - 1) / 2) * spacing;
            var k = 0;
            for (var c = 0; c < count; c += 1)
            {
                const along = first + c * spacing;
                // Front and back edges: the capacitor's long side runs along X.
                for (var sgn in [1, -1])
                {
                    fCuboid(context, id + ("cap" ~ k), {
                            "corner1" : vector(along - length / 2, sgn * edge - width / 2, zero),
                            "corner2" : vector(along + length / 2, sgn * edge + width / 2, height)
                    });
                    k += 1;
                    fCuboid(context, id + ("cap" ~ k), {
                            "corner1" : vector(sgn * edge - width / 2, along - length / 2, zero),
                            "corner2" : vector(sgn * edge + width / 2, along + length / 2, height)
                    });
                    k += 1;
                }
            }
            for (var m = 0; m < k; m += 1)
            {
                namePart(context, qCreatedBy(id + ("cap" ~ m), EntityType.BODY), "Capacitor " ~ (m + 1), color(0.16, 0.17, 0.2));
            }
        }
    }, {
        packageSize : 40 * millimeter,
        packageThickness : 1.6 * millimeter,
        cornerMark : 2.5 * millimeter,
        lidSize : 28 * millimeter,
        lidHeight : 2.4 * millimeter,
        lidRadius : 0.5 * millimeter,
        hasPins : true,
        pinsPerSide : 26,
        emptyCentre : 8,
        pinPitch : 1.27 * millimeter,
        pinDiameter : 0.35 * millimeter,
        pinLength : 3 * millimeter,
        hasTraces : true,
        tracesPerSide : 14,
        traceWidth : 0.3 * millimeter,
        traceFan : 2.5 * millimeter,
        hasCapacitors : true,
        capsPerEdge : 7,
        capLength : 2 * millimeter
    });

/** Gives a body a part name and an appearance colour. */
function namePart(context is Context, body is Query, name is string, appearance is Color)
{
    setProperty(context, { "entities" : body, "propertyType" : PropertyType.NAME, "value" : name });
    setProperty(context, { "entities" : body, "propertyType" : PropertyType.APPEARANCE, "value" : appearance });
}
